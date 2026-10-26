use wasm_bindgen::prelude::*;

/// Prototype only. The caller must supply fresh WebCrypto randomness.
#[wasm_bindgen]
pub fn contribute_with_entropy(params: Vec<u8>, entropy: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    if entropy.len() != 64 {
        return Err(JsValue::from_str("64 bytes of WebCrypto entropy required"));
    }
    phase2::contribute(params, entropy)
}
