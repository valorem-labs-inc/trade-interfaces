use ethers::contract::abigen;

abigen!(
    Erc20,
    "../abi/IERC20.json",
    derives(serde::Deserialize, serde::Serialize)
);
