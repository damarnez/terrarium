//! terrarium-evm: revm behind a tiny host interface, compiled to WebAssembly.
//!
//! The JavaScript side owns ALL state (accounts, code, storage, checkpoints, persistence, fork recording). This crate
//! only executes: it asks the host for whatever it reads, and returns the result plus the state diff to apply.
//! If the host cannot answer synchronously (fork mode: the slot has to be fetched from a node), it throws an error
//! marked `missing`; execution aborts, the host fetches, and re-runs. Reads are recorded, so re-runs are exact.
use std::collections::HashMap;
use std::str::FromStr;

use revm::context::{BlockEnv, CfgEnv, Context, TxEnv};
use revm::context_interface::result::{EVMError, ExecutionResult, Output};
use revm::database_interface::{DBErrorMarker, Database};
use revm::handler::{MainBuilder, MainContext};
use revm::inspector::{InspectEvm, Inspector};
use revm::interpreter::interpreter::EthInterpreter;
use revm::interpreter::interpreter_types::{InputsTr, Jumps, StackTr};
#[allow(unused_imports)] use StackTr as _StackTrUsed;
use revm::interpreter::Interpreter;
use revm::primitives::hardfork::SpecId;
use revm::primitives::{Address, Bytes, TxKind, B256, U256};
use revm::state::{AccountInfo, Bytecode};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------- the host (JavaScript) ------------------------------
#[wasm_bindgen]
extern "C" {
    pub type Host;
    /// -> null (no account) | { balance, nonce, codeHash, code } as hex strings. Throws { missing: true } to abort.
    #[wasm_bindgen(method, catch)]
    fn account(this: &Host, address: &str) -> Result<JsValue, JsValue>;
    /// -> 32-byte hex
    #[wasm_bindgen(method, catch)]
    fn storage(this: &Host, address: &str, slot: &str) -> Result<JsValue, JsValue>;
    /// -> 32-byte hex
    #[wasm_bindgen(method, catch, js_name = blockHash)]
    fn block_hash(this: &Host, number: f64) -> Result<JsValue, JsValue>;
}

#[derive(Debug)]
pub enum HostError { Missing, Other(String) }
impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { match self { HostError::Missing => write!(f, "missing state"), HostError::Other(s) => write!(f, "{s}") } }
}
impl std::error::Error for HostError {}
impl DBErrorMarker for HostError {}

fn js_err(e: JsValue) -> HostError {
    let missing = js_sys::Reflect::get(&e, &JsValue::from_str("missing")).ok().and_then(|v| v.as_bool()).unwrap_or(false);
    if missing { HostError::Missing } else { HostError::Other(format!("{e:?}")) }
}
fn js_str(v: &JsValue, key: &str) -> Result<String, HostError> {
    js_sys::Reflect::get(v, &JsValue::from_str(key)).ok().and_then(|x| x.as_string()).ok_or_else(|| HostError::Other(format!("host returned no `{key}`")))
}
fn parse_u256(s: &str) -> Result<U256, HostError> { U256::from_str(s).map_err(|e| HostError::Other(format!("bad u256 {s}: {e}"))) }
fn parse_b256(s: &str) -> Result<B256, HostError> { B256::from_str(s).map_err(|e| HostError::Other(format!("bad b256 {s}: {e}"))) }
fn parse_addr(s: &str) -> Result<Address, HostError> { Address::from_str(s).map_err(|e| HostError::Other(format!("bad address {s}: {e}"))) }
fn parse_bytes(s: &str) -> Result<Bytes, HostError> { Bytes::from_str(s).map_err(|e| HostError::Other(format!("bad bytes: {e}"))) }

/// revm's view of the world: every read goes to the host, cached for the duration of one run.
struct HostDb<'a> { host: &'a Host, accounts: HashMap<Address, Option<AccountInfo>>, storage: HashMap<(Address, U256), U256> }

impl<'a> Database for HostDb<'a> {
    type Error = HostError;
    fn basic(&mut self, address: Address) -> Result<Option<AccountInfo>, HostError> {
        if let Some(a) = self.accounts.get(&address) { return Ok(a.clone()); }
        let v = self.host.account(&format!("{address:?}")).map_err(js_err)?;
        let info = if v.is_null() || v.is_undefined() { None } else {
            let code = parse_bytes(&js_str(&v, "code")?)?;
            let code_hash = parse_b256(&js_str(&v, "codeHash")?)?;
            let mut info = AccountInfo::default();
            info.balance = parse_u256(&js_str(&v, "balance")?)?; info.nonce = parse_u256(&js_str(&v, "nonce")?)?.to::<u64>(); info.code_hash = code_hash;
            if !code.is_empty() { info.code = Some(Bytecode::new_raw(code)); }   // code comes with the account: revm never needs code_by_hash
            Some(info)
        };
        self.accounts.insert(address, info.clone());
        Ok(info)
    }
    fn code_by_hash(&mut self, _code_hash: B256) -> Result<Bytecode, HostError> { Ok(Bytecode::default()) }   // never reached: basic() carries the code
    fn storage(&mut self, address: Address, index: U256) -> Result<U256, HostError> {
        if let Some(v) = self.storage.get(&(address, index)) { return Ok(*v); }
        let v = self.host.storage(&format!("{address:?}"), &format!("{index:#066x}")).map_err(js_err)?;
        let value = parse_u256(&v.as_string().ok_or_else(|| HostError::Other("storage: not a string".into()))?)?;
        self.storage.insert((address, index), value);
        Ok(value)
    }
    fn block_hash(&mut self, number: u64) -> Result<B256, HostError> {
        let v = self.host.block_hash(number as f64).map_err(js_err)?;
        parse_b256(&v.as_string().ok_or_else(|| HostError::Other("blockHash: not a string".into()))?)
    }
}

// ---------------------------------------------------------------- SLOAD tracer (for `deal`'s slot discovery) ---------
#[derive(Default)]
struct SloadTracer { on: bool, reads: Vec<(Address, U256)> }
impl<CTX> Inspector<CTX, EthInterpreter> for SloadTracer {
    fn step(&mut self, interp: &mut Interpreter<EthInterpreter>, _ctx: &mut CTX) {
        if self.on && interp.bytecode.opcode() == 0x54 {
            if let Some(slot) = interp.stack.top() { let slot = *slot; self.reads.push((interp.input.target_address(), slot)); }
        }
    }
}

// ---------------------------------------------------------------- request / response ----------------------------------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest { tx: TxIn, block: BlockIn, cfg: CfgIn }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxIn { from: String, to: Option<String>, value: String, data: String, gas_limit: String, gas_price: String, priority_fee: Option<String>, nonce: Option<String>, tx_type: Option<u8> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockIn { number: String, timestamp: String, gas_limit: String, base_fee: String, coinbase: Option<String>, prev_randao: Option<String> }
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CfgIn { chain_id: u64, spec: Option<String>, skip_balance: bool, skip_nonce: bool, skip_block_gas_limit: bool, no_base_fee: bool, skip_eip3607: bool, trace_sloads: bool }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogOut { address: String, topics: Vec<String>, data: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountOut { address: String, deleted: bool, balance: String, nonce: String, code_hash: String, code: Option<String>, storage: Vec<(String, String)> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult { success: bool, reason: String, gas_used: u64, gas_refunded: u64, output: String, created: Option<String>, logs: Vec<LogOut>, state: Vec<AccountOut>, sloads: Vec<(String, String)> }

fn spec_of(name: Option<&str>) -> SpecId {
    match name.map(|s| s.to_ascii_lowercase()).as_deref() { Some("prague") => SpecId::PRAGUE, Some("shanghai") => SpecId::SHANGHAI, Some("merge") | Some("paris") => SpecId::MERGE, Some("osaka") => SpecId::OSAKA, _ => SpecId::CANCUN }
}
fn u64_of(s: &str) -> Result<u64, HostError> { Ok(parse_u256(s)?.to::<u64>()) }
fn u128_of(s: &str) -> Result<u128, HostError> { Ok(parse_u256(s)?.to::<u128>()) }

#[wasm_bindgen]
pub fn version() -> String { format!("terrarium-evm {} / revm 43", env!("CARGO_PKG_VERSION")) }

/// Execute one transaction. `request` is a JSON string (RunRequest); returns a JSON string (RunResult).
/// Throws a string starting with `missing` when the host could not provide some state (re-run after fetching), and a
/// string starting with `invalid:` for a transaction the node would refuse (bad nonce, insufficient funds...).
#[wasm_bindgen]
pub fn run(host: &Host, request: &str) -> Result<String, JsValue> {
    let req: RunRequest = serde_json::from_str(request).map_err(|e| JsValue::from_str(&format!("bad request: {e}")))?;
    run_inner(host, req).map_err(|e| JsValue::from_str(&e))
}

fn run_inner(host: &Host, req: RunRequest) -> Result<String, String> {
    let h = |e: HostError| e.to_string();
    let block = BlockEnv {
        number: parse_u256(&req.block.number).map_err(h)?,
        beneficiary: req.block.coinbase.as_deref().map(parse_addr).transpose().map_err(h)?.unwrap_or(Address::ZERO),
        timestamp: parse_u256(&req.block.timestamp).map_err(h)?,
        gas_limit: u64_of(&req.block.gas_limit).map_err(h)?,
        basefee: u64_of(&req.block.base_fee).map_err(h)?,
        difficulty: U256::ZERO,
        prevrandao: Some(req.block.prev_randao.as_deref().map(parse_b256).transpose().map_err(h)?.unwrap_or(B256::ZERO)),
        ..Default::default()
    };
    let caller = parse_addr(&req.tx.from).map_err(h)?;
    let tx = TxEnv {
        tx_type: req.tx.tx_type.unwrap_or(2),
        caller,
        gas_limit: u64_of(&req.tx.gas_limit).map_err(h)?,
        gas_price: u128_of(&req.tx.gas_price).map_err(h)?,
        gas_priority_fee: req.tx.priority_fee.as_deref().map(u128_of).transpose().map_err(h)?,
        kind: match &req.tx.to { Some(to) => TxKind::Call(parse_addr(to).map_err(h)?), None => TxKind::Create },
        value: parse_u256(&req.tx.value).map_err(h)?,
        data: parse_bytes(&req.tx.data).map_err(h)?,
        nonce: req.tx.nonce.as_deref().map(u64_of).transpose().map_err(h)?.unwrap_or(0),
        chain_id: Some(req.cfg.chain_id),
        ..Default::default()
    };
    let mut cfg = CfgEnv::new_with_spec(spec_of(req.cfg.spec.as_deref()));
    cfg.chain_id = req.cfg.chain_id;
    cfg.disable_nonce_check = req.cfg.skip_nonce;
    cfg.disable_balance_check = req.cfg.skip_balance;
    cfg.disable_block_gas_limit = req.cfg.skip_block_gas_limit;
    cfg.disable_base_fee = req.cfg.no_base_fee;
    cfg.disable_eip3607 = req.cfg.skip_eip3607;   // simulations may originate from a contract address
    cfg.limit_contract_code_size = Some(usize::MAX);   // allowUnlimitedContractSize, like the JS engine
    cfg.limit_contract_initcode_size = Some(usize::MAX);

    let db = HostDb { host, accounts: HashMap::new(), storage: HashMap::new() };
    let ctx = Context::mainnet().with_db(db).with_block(block).with_cfg(cfg);
    let mut evm = ctx.build_mainnet_with_inspector(SloadTracer { on: req.cfg.trace_sloads, reads: Vec::new() });
    let res = match evm.inspect_tx(tx) {
        Ok(r) => r,
        Err(EVMError::Database(HostError::Missing)) => return Err("missing".into()),
        Err(EVMError::Database(e)) => return Err(format!("host: {e}")),
        Err(EVMError::Transaction(e)) => return Err(format!("invalid: {e:?}")),
        Err(EVMError::Header(e)) => return Err(format!("invalid header: {e:?}")),
        Err(e) => return Err(format!("evm: {e:?}")),
    };
    let sloads = evm.inspector.reads.iter().map(|(a, s)| (format!("{a:?}"), format!("{s:#066x}"))).collect();

    let (success, reason, gas, logs, output, created) = match res.result {
        ExecutionResult::Success { reason, gas, logs, output } => { let created = match &output { Output::Create(_, addr) => addr.map(|a| format!("{a:?}")), _ => None }; (true, format!("{reason:?}"), gas, logs, output.into_data(), created) }
        ExecutionResult::Revert { gas, logs, output } => (false, "revert".to_string(), gas, logs, output, None),
        ExecutionResult::Halt { reason, gas, logs } => (false, format!("{reason:?}"), gas, logs, Bytes::new(), None),
    };
    let mut state = Vec::new();
    for (address, acc) in res.state.iter() {
        if !acc.is_touched() { continue; }
        let deleted = acc.is_selfdestructed() || acc.is_empty();
        let storage = acc.storage.iter().filter(|(_, s)| s.is_changed()).map(|(k, s)| (format!("{k:#066x}"), format!("{:#066x}", s.present_value))).collect();
        let code = if acc.is_created() { acc.info.code.as_ref().map(|c| format!("0x{}", hex::encode(c.original_byte_slice()))) } else { None };
        state.push(AccountOut { address: format!("{address:?}"), deleted, balance: format!("{:#x}", acc.info.balance), nonce: format!("{:#x}", acc.info.nonce), code_hash: format!("{:?}", acc.info.code_hash), code, storage });
    }
    let out = RunResult {
        success, reason, gas_used: gas.tx_gas_used(), gas_refunded: gas.final_refunded(),
        output: format!("0x{}", hex::encode(&output)), created,
        logs: logs.iter().map(|l| LogOut { address: format!("{:?}", l.address), topics: l.data.topics().iter().map(|t| format!("{t:?}")).collect(), data: format!("0x{}", hex::encode(&l.data.data)) }).collect(),
        state, sloads,
    };
    serde_json::to_string(&out).map_err(|e| e.to_string())
}
