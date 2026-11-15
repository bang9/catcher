// Thin wrappers over RustCrypto / dalek so the rest of the code never touches curve APIs directly.

use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};

/// Source of random bytes; tests pass a deterministic one.
pub type Random<'a> = &'a mut dyn FnMut(usize) -> Vec<u8>;

pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    // the OS RNG does not fail on supported platforms; a zero buffer would be caught nowhere, so stop hard
    if getrandom::fill(&mut buf).is_err() {
        eprintln!("catcher: no secure random source");
        std::process::exit(1);
    }
    buf
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn sha256_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// HKDF-SHA256 with an optional salt, 32 bytes out.
pub fn derive(ikm: &[u8], info: &str, salt: Option<&[u8]>) -> [u8; 32] {
    let mut out = [0u8; 32];
    // 32 bytes is always a valid HKDF-SHA256 length
    let _ = Hkdf::<Sha256>::new(salt, ikm).expand(info.as_bytes(), &mut out);
    out
}

pub fn sign_public(secret: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(secret).verifying_key().to_bytes()
}

pub fn sign(message: &[u8], secret: &[u8; 32]) -> [u8; 64] {
    SigningKey::from_bytes(secret).sign(message).to_bytes()
}

/// Any malformed key or signature is just "not valid".
pub fn verify(signature: &[u8], message: &[u8], public_key: &[u8]) -> bool {
    let (Ok(sig), Ok(pk)) = (
        <&[u8; 64]>::try_from(signature),
        <&[u8; 32]>::try_from(public_key),
    ) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(pk) else {
        return false;
    };
    ed25519_dalek::Verifier::verify(&key, message, &Signature::from_bytes(sig)).is_ok()
}

pub fn box_public(secret: &[u8; 32]) -> [u8; 32] {
    x25519_dalek::x25519(*secret, x25519_dalek::X25519_BASEPOINT_BYTES)
}

/// X25519; an all-zero result (small-order peer key) is refused like @noble/curves does.
pub fn shared_secret(secret: &[u8; 32], peer_public: &[u8]) -> Result<[u8; 32], String> {
    let peer: [u8; 32] = peer_public
        .try_into()
        .map_err(|_| "invalid private or public key received".to_string())?;
    let out = x25519_dalek::x25519(*secret, peer);
    if out.iter().all(|b| *b == 0) {
        return Err("invalid private or public key received".into());
    }
    Ok(out)
}

fn cipher(key: &[u8], nonce: &[u8]) -> Result<XChaCha20Poly1305, String> {
    if nonce.len() != 24 {
        return Err(format!(
            "\"nonce\" expected Uint8Array of length 24, got length={}",
            nonce.len()
        ));
    }
    XChaCha20Poly1305::new_from_slice(key).map_err(|_| {
        format!(
            "\"key\" expected Uint8Array of length 32, got length={}",
            key.len()
        )
    })
}

pub fn seal(key: &[u8], nonce: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    let c = cipher(key, nonce)?;
    c.encrypt(
        nonce.try_into().map_err(|_| "bad nonce")?,
        Payload {
            msg: plaintext,
            aad,
        },
    )
    .map_err(|_| "encryption failed".to_string())
}

pub fn unseal(key: &[u8], nonce: &[u8], ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    let c = cipher(key, nonce)?;
    if ciphertext.len() < 16 {
        return Err("\"ciphertext\" expected length >= tagLength=16".into());
    }
    c.decrypt(
        nonce.try_into().map_err(|_| "bad nonce")?,
        Payload {
            msg: ciphertext,
            aad,
        },
    )
    .map_err(|_| "invalid tag".to_string())
}
