use std::sync::OnceLock;
static ENCODER: OnceLock<tiktoken_rs::CoreBPE> = OnceLock::new();

pub(crate) fn tokens(text: &str) -> usize {
    ENCODER
        .get_or_init(|| tiktoken_rs::o200k_base().expect("bundled o200k tokenizer"))
        .encode_ordinary(text)
        .len()
}
