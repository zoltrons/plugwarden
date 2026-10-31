//! The autofill engine as WebAssembly, run in the service worker. Separate from `core-wasm` on purpose:
//! everything it reads is page-controlled, and the module that holds the keys must never parse that.
//! JSON in, JSON out; a parse failure comes back as an error and the caller fills nothing.
use autofill_cpd::CollectedPageDetails;
use autofill_fill::{FillIntent, plan_fill};
use autofill_resolver::analyze;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

fn to_js(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// `CollectedPageDetails` -> `AnalyzedFrameResult`.
#[wasm_bindgen]
pub fn analyze_page(details: &str) -> Result<String, JsError> {
    let page: CollectedPageDetails = serde_json::from_str(details).map_err(to_js)?;
    serde_json::to_string(&analyze(&page)).map_err(to_js)
}

#[derive(Deserialize)]
struct PlanRequest {
    details: CollectedPageDetails,
    intent: FillIntent,
}

/// `{ details, intent }` -> `FillPlan`.
#[wasm_bindgen]
pub fn plan(request: &str) -> Result<String, JsError> {
    let req: PlanRequest = serde_json::from_str(request).map_err(to_js)?;
    serde_json::to_string(&plan_fill(&req.details, &req.intent)).map_err(to_js)
}
