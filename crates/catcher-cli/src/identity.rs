// Identities: one 32-byte seed per party; both key pairs derive from it with HKDF.

use crate::bytes::{b32, b64, groups, unb32};
use crate::crypto::{box_public, derive, sha256, sha256_parts, sign_public};

#[derive(Clone)]
pub struct Identity {
    pub seed: [u8; 32],
    pub sign_secret: [u8; 32],
    pub sign_pub: [u8; 32],
    pub box_secret: [u8; 32],
    pub box_pub: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicKeys {
    pub sign_pub: String,
    pub box_pub: String,
}

pub fn identity_from_seed(seed: &[u8]) -> Result<Identity, String> {
    let seed: [u8; 32] = seed
        .try_into()
        .map_err(|_| "seed must be 32 bytes".to_string())?;
    let sign_secret = derive(&seed, "catcher/v1/sign", None);
    let box_secret = derive(&seed, "catcher/v1/box", None);
    Ok(Identity {
        seed,
        sign_secret,
        sign_pub: sign_public(&sign_secret),
        box_secret,
        box_pub: box_public(&box_secret),
    })
}

pub fn public_keys(id: &Identity) -> PublicKeys {
    PublicKeys {
        sign_pub: b64(&id.sign_pub),
        box_pub: b64(&id.box_pub),
    }
}

/// 16 characters people compare between the CLI and the app: ABCD-EFGH-JKMN-PQRS
pub fn fingerprint(sign_pub: &str, box_pub: &str) -> String {
    let digest = sha256_parts(&[
        b"catcher/v1/fingerprint",
        sign_pub.as_bytes(),
        b".",
        box_pub.as_bytes(),
    ]);
    groups(&b32(&digest[..10]), 4)
}

pub fn owner_id_for(genesis_sign_pub: &str) -> String {
    let digest = sha256_parts(&[b"catcher/v1/owner", genesis_sign_pub.as_bytes()]);
    format!("o_{}", b32(&digest[..12]).to_lowercase())
}

pub fn random_id(prefix: char, random: &mut dyn FnMut(usize) -> Vec<u8>) -> String {
    let len = if prefix == 'm' { 16 } else { 10 };
    format!("{prefix}_{}", b32(&random(len)).to_lowercase())
}

/// seed + 2-byte checksum in Crockford base32, groups of 5
pub fn recovery_code(seed: &[u8]) -> String {
    let check = sha256_parts(&[b"catcher/v1/recovery", seed]);
    let mut raw = seed.to_vec();
    raw.extend_from_slice(&check[..2]);
    groups(&b32(&raw), 5)
}

pub fn seed_from_recovery_code(code: &str) -> Result<[u8; 32], String> {
    let raw = unb32(code)?;
    if raw.len() < 34 {
        return Err("recovery code is too short".into());
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&raw[..32]);
    let expected = sha256(&[b"catcher/v1/recovery".as_slice(), &seed].concat());
    if raw[32..34] != expected[..2] {
        return Err("recovery code has a typo".into());
    }
    Ok(seed)
}
