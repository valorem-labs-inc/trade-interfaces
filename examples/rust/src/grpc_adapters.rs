// Setup From traits allowing the conversion between proto types and ethers types.
// Reference: https://github.com/ledgerwatch/interfaces/blob/master/src/lib.rs
use crate::grpc_codegen::*;
use arrayref::array_ref;
use ethers::abi::AbiEncode;

// Macro allowing for proto types to be converted into numbers (and vice versa), moving
// through the fixed hash type first.
macro_rules! into_from {
    ($proto:ty, $hash:ty, $num:ty) => {
        impl From<$num> for $proto {
            fn from(value: $num) -> Self {
                Self::from(<$hash>::from(<[u8; <$hash>::len_bytes()]>::from(value)))
            }
        }

        impl From<$proto> for $num {
            fn from(value: $proto) -> Self {
                Self::from(<$hash>::from(value).0)
            }
        }
    };
}

into_from!(H128, ethers::types::H128, ethers::types::U128);
into_from!(H256, ethers::types::H256, ethers::types::U256);

impl From<ethers::types::H128> for H128 {
    fn from(value: ethers::types::H128) -> Self {
        Self {
            hi: u64::from_be_bytes(*array_ref!(value, 0, 8)),
            lo: u64::from_be_bytes(*array_ref!(value, 8, 8)),
        }
    }
}

impl From<H128> for ethers::types::H128 {
    fn from(value: H128) -> Self {
        let mut v = [0; Self::len_bytes()];
        v[..8].copy_from_slice(&value.hi.to_be_bytes());
        v[8..].copy_from_slice(&value.lo.to_be_bytes());
        v.into()
    }
}

impl From<ethers::types::H160> for H160 {
    fn from(value: ethers::types::H160) -> Self {
        Self {
            hi: Some(ethers::types::H128::from_slice(&value[..16]).into()),
            lo: u32::from_be_bytes(*array_ref!(value, 16, 4)),
        }
    }
}

impl From<H160> for ethers::types::H160 {
    fn from(value: H160) -> Self {
        type H = ethers::types::H128;

        let mut v = [0; Self::len_bytes()];
        v[..H::len_bytes()].copy_from_slice(H::from(value.hi.unwrap_or_default()).as_fixed_bytes());
        v[H::len_bytes()..].copy_from_slice(&value.lo.to_be_bytes());

        v.into()
    }
}

impl From<ethers::types::H256> for H256 {
    fn from(value: ethers::types::H256) -> Self {
        Self {
            hi: Some(ethers::types::H128::from_slice(&value[..16]).into()),
            lo: Some(ethers::types::H128::from_slice(&value[16..]).into()),
        }
    }
}

impl From<H256> for ethers::types::H256 {
    fn from(value: H256) -> Self {
        type H = ethers::types::H128;

        let mut v = [0; Self::len_bytes()];
        v[..H::len_bytes()].copy_from_slice(H::from(value.hi.unwrap_or_default()).as_fixed_bytes());
        v[H::len_bytes()..].copy_from_slice(H::from(value.lo.unwrap_or_default()).as_fixed_bytes());

        v.into()
    }
}

impl From<EthSignature> for ethers::types::Signature {
    fn from(value: EthSignature) -> Self {
        let mut bytes = [0u8; 65];
        bytes[..32].copy_from_slice(value.r.as_slice());
        bytes[32..64].copy_from_slice(value.s.as_slice());
        bytes[64] = *value.v.first().unwrap();
        ethers::types::Signature::try_from(bytes.as_slice()).unwrap()
    }
}

impl From<ethers::types::Signature> for EthSignature {
    fn from(value: ethers::types::Signature) -> Self {
        // We don't want to directly encode v, as this will be encoded as a u64 where leading
        // zeros matter (so it will be included). We know its only 1 byte, therefore only push 1 byte
        // of data so the signature remains 65 bytes on the wire.
        Self {
            v: vec![value.v.to_le_bytes()[0]],
            r: value.r.encode(),
            s: value.s.encode(),
        }
    }
}

impl From<i32> for Action {
    fn from(value: i32) -> Self {
        Action::from_i32(value).unwrap_or(Action::Invalid)
    }
}

impl From<i32> for ItemType {
    fn from(value: i32) -> Self {
        ItemType::from_i32(value).unwrap_or(ItemType::Native)
    }
}
