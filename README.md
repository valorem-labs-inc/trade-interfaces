# Valorem Trade API

![Valorem Trade API](img/valorem-trade-api-banner.png)

> The Valorem Trade API enables peer-to-peer, signature-based, noncustodial
> digital asset trading via low latency [gRPC](https://grpc.io/docs/what-is-grpc/introduction/) and
> [gRPC-web](https://github.com/grpc/grpc-web)
> TLS-encrypted [version 3 protocol buffer](https://protobuf.dev/programming-guides/proto3/)
> interfaces, with order settlement via
> the [Seaport smart contracts](https://github.com/ProjectOpenSea/seaport).
> The complete protobuf definitions can be found
> [here](https://github.com/valorem-labs-inc/trade-interfaces/tree/main/proto/).

## Table of Contents

- [Deployments](#deployments)
- [Install](#install)
- [Usage](#usage)
- [Contributing](#contributing)
- [License](#license)
- [API Reference](#api-reference)
  - [User roles](#user-roles)
  - [TLS Certificate Authority](#tls-certificate-authority)
  - [ALPN](#alpn)
  - [Keepalives and timeouts](#keepalives-and-timeouts)
  - [Errors and status codes](#errors-and-status-codes)
  - [Rate limiting](#rate-limiting)
  - [Primitive data types](#primitive-data-types)
    - [H128](#h128)
    - [H160](#h160)
    - [H256](#h256)
    - [Empty](#empty)
    - [EthSignature](#ethsignature)
  - [Seaport data types](#seaport-data-types)
    - [ItemType](#itemtype)
    - [ConsiderationItem](#considerationitem)
    - [OfferItem](#offeritem)
    - [OrderType](#ordertype)
    - [Order](#order)
    - [SignedOrder](#signedorder)
  - [API Services](#api-services)
    - [Health](#health)
    - [Reflection](#reflection)
    - [Auth service](#auth-service)
      - [Methods](#methods)
        - [Nonce](#nonce)
        - [Verify](#verify)
        - [Authenticate](#authenticate)
        - [Session](#session)
        - [SignOut](#signout)
    - [Fees](#fees)
      - [Methods](#methods-1)
        - [getFeeStructure](#getfeestructure)
    - [RFQ](#rfq)
      - [Trading Valorem Clear Options](#trading-valorem-clear-options)
      - [Authentication and authorization](#authentication-and-authorization)
      - [Methods](#methods-2)
        - [Taker](#taker-1)
        - [Maker](#maker-1)
        - [WebTaker](#webtaker)
    - [Soft Quote](#soft-quote)
      - [Quoting Valorem Clear Options](#quoting-valorem-clear-options)
      - [Authentication and authorization](#authentication-and-authorization-1)
      - [Methods](#methods-3)
        - [Taker](#taker-2)
        - [Maker](#maker-2)
        - [WebTaker](#webtaker-1)

## Deployments

The public endpoint for the Valorem Trade API is `https://trade.valorem.xyz`.

## Install

Protobuf has code generation for most languages. The trade-api interfaces in 
this repository are meant to be used as low-level interfaces, leveraging 
code generation in the language of your choice. The repository is best installed
to your codebase as a git submodule, with a pinned version tag.

## Usage

Usage is spelled out in great detail at a low level in the API reference
documentation which follows. You can also review the example clients in 
[examples](examples/).

## Contributing

Contributions are welcome!

## License

These interfaces and examples are licensed under the MIT License. Please see
the [LICENSE](LICENSE) file for details.

## API Reference

### User roles

There are two principal user roles in the Valorem Trade API:

- **Maker**: Makers sign offers in response to requests for quotes (RFQs).
  They are responsible for having the requisite assets when a taker optionally
  fills their signed offer. Makers are presently required to request access to
  the maker API via the [Valorem discord](https://discord.gg/valorem).

- **Taker**: Takers request quotes from makers and optionally
  execute signed offers via the Seaport smart contracts.

### TLS Certificate Authority

The Valorem Trade API uses the GoDaddy Root TLS certificate authority (CA) to
issue certificates; some protobuf clients may need to add this CA, which can be
found [here](https://github.com/valorem-labs-inc/trade-interfaces/blob/main/certs/trade.valorem.xyz.pem).

### ALPN

The Valorem Trade API supports HTTP/2 via the `h2` ALPN protocol.

### Keepalives and timeouts

The Valorem Trade API sends HTTP/2 keepalives every 75 seconds and times out
after 10 seconds if a response is not received. Users of the API should use HTTP/2
keepalives, and not issue TCP keepalives.

### Errors and status codes

The Valorem Trade API uses the [gRPC richer error model](https://grpc.io/docs/guides/error/#richer-error-model).
It additionally uses [standard gRPC status codes](https://grpc.github.io/grpc/core/md_doc_statuscodes.html) to
indicate the success or failure of an API call.

This allows the client to programmatically determine the cause of an error and
take appropriate action.

### Rate limiting

Rate limits are applied to certain services and methods in the Valorem Trade API.
These rate limits are subject to change and are not guaranteed. Details about
any applied rate limits can be found on the service and method documentation.

### Primitive data types

The trade API defines some primitive data types mirroring a subset of
the [Solidity ABI](https://docs.soliditylang.org/en/latest/abi-spec.html):

#### H128

A 128-bit data type

```protobuf
message H128 {
  uint64 hi = 1;
  uint64 lo = 2;
}
```

#### H160

A 160-bit data type

```protobuf
message H160 {
  H128 hi = 1;
  uint32 lo = 2;
}
```

#### H256

A 256-bit data type

```protobuf
message H256 {
  H128 hi = 1;
  H128 lo = 2;
}
```

As well as a few utility types:

#### Empty

An empty message type

```protobuf
message Empty {}
```

#### EthSignature

An Ethereum signature. [ECDSA](https://en.wikipedia.org/wiki/Elliptic_Curve_Digital_Signature_Algorithm) signatures in
Ethereum consist of three parameters:
`v`, `r` and `s`. The signature is always 65-bytes in length.

- `r` (`bytes`): first 32 bytes of signature
- `s` (`bytes`): second 32 bytes of signature
- `v` (`bytes`): 1 byte of signature

```protobuf
message EthSignature {
  bytes r = 1;
  bytes s = 2;
  bytes v = 3;
}
```

### Seaport data types

This section describes protobuf data types and messages used by the Trade API as
they relate to Seaport.

**For a full reference on the Seaport smart contracts and interfaces, see
the [Seaport documentation](https://docs.opensea.io/reference/seaport-overview).**

#### ItemType

The ItemType designates the type of item, with valid types being Ether
(or other native token for the given chain),
[ERC20](https://ethereum.org/en/developers/docs/standards/tokens/erc-20/),
[ERC721](https://ethereum.org/en/developers/docs/standards/tokens/erc-721/),
[ERC1155](https://ethereum.org/en/developers/docs/standards/tokens/erc-1155/),
ERC721 with "criteria" (explained below), and ERC1155 with criteria.

```protobuf
enum ItemType {
  NATIVE = 0;
  ERC20 = 1;
  ERC721 = 2;
  ERC1155 = 3;
  ERC721_WITH_CRITERIA = 4;
  ERC1155_WITH_CRITERIA = 5;
}
```

#### ConsiderationItem

An item required in exchange for an offer.

```protobuf
message ConsiderationItem {
  ItemType item_type = 1;
  H160 token = 2;
  H256 identifier_or_criteria = 3;
  H256 start_amount = 4;
  H256 end_amount = 5;
  H160 recipient = 6;
}
```

#### OfferItem

An item offered in exchange for consideration.

```protobuf
message OfferItem {
  ItemType item_type = 1;
  H160 token = 2;
  H256 identifier_or_criteria = 3;
  H256 start_amount = 4;
  H256 end_amount = 5;
}
```

- `item_type`: Designates the type of item.
- `token`: Designates the account of the item's token contract (with the null
  address used for Ether or other native tokens).
- `identifier_or_criteria`: Represents either the ERC721 or ERC1155
  token identifier or, in the case of a criteria-based item type, a
  merkle root composed of the valid set of token identifiers for
  the item. This value will be ignored for Ether and ERC20 item types,
  and can optionally be zero for criteria-based item types to allow
  for any identifier.
- `start_amount`: Represents the amount of the item in question that
  will be required should the order be fulfilled at the moment the
  order becomes active.
- `end_amount`: Represents the amount of the item in question that
  will be required should the order be fulfilled at the moment the
  order expires. If this value differs from the item's `start_amount`,
  the realized amount is calculated linearly based on the time elapsed
  since the order became active.

#### OrderType

Designates one of four types for the order depending on two distinct preferences:

```protobuf
enum OrderType {
  FULL_OPEN = 0;
  PARTIAL_OPEN = 1;
  FULL_RESTRICTED = 2;
  PARTIAL_RESTRICTED = 3;
}
```

- `FULL` indicates that the order does not support partial fills,
  whereas `PARTIAL` enables filling some fraction of the order, with the
  important caveat that each item must be cleanly divisible by the supplied
  fraction (i.e. no remainder after division). `OPEN` indicates that the call to
  execute the order can be submitted by any account, whereas `RESTRICTED` requires
  that the order either be executed by the `offerer` or the `zone` of the order, or
  that a magic value indicating that the order is approved is returned upon
  calling validateOrder on the zone.

#### Order

A Seaport order. Each order contains ten key components.

```protobuf
message Order {
  H160 offerer = 1;
  H160 zone = 2;
  repeated OfferItem offer = 3;
  repeated ConsiderationItem consideration = 4;
  OrderType order_type = 5;
  H256 start_time = 6;
  H256 end_time = 7;
  H256 zone_hash = 8;
  H256 salt = 9;
  H256 conduit_key = 10;
}
```

- `offerer`: Supplies all offered items and must either
  fulfill the order personally (i.e. `msg.sender == offerer`) or approve
  the order via signature (either standard 65-byte EDCSA, 64-byte
  [EIP-2098](https://eips.ethereum.org/EIPS/eip-2098),
  or an [EIP-1271](https://eips.ethereum.org/EIPS/eip-1271) `isValidSignature` check) or by listing the order
  on-chain (i.e. calling `validate`).
- `zone`: An optional secondary account attached to the
  order with two additional privileges:
  - The zone may cancel orders where it is named as the zone by calling
    cancel. (Note that `offerer`s can also cancel their own orders, either
    individually or for all orders signed with their current counter at
    once by calling `incrementCounter`).
  - "Restricted" orders (as specified by the `order_type`) must either be
    executed by the zone or the `offerer`, or must be approved as indicated
    by a call to an `validateOrder` on the `zone`.
- `offer`: Contains an array of items that may be transferred
  from the `offerer`'s account.
- `consideration`: Contains an array of items that must be received
  in order to fulfill the order. It contains the same components
  as an offered item, and additionally includes a recipient that will
  receive each item. This array may be extended by the fulfiller on
  order fulfillment as to support "tipping" (e.g. relayer or
  referral payments)
- `order_type`: Indicates whether the order supports partial fills
  and whether the order can be executed by any account or only by the
  `offerer` or `zone`.
- `start_time`: Indicates the block timestamp at which the order
  becomes active.
- `end_time`: Indicates the block timestamp at which the order expires.
  This value and the `start_time` are used in conjunction with the
  `start_amount` and `end_amount` of each item to derive their current amount.
- `zone_hash`: Represents an arbitrary `bytes32` value that will be
  supplied to the `zone` when fulfilling restricted orders that the `zone`
  can utilize when making a determination on whether to authorize the order.
- `salt`: Represents an arbitrary source of entropy for the order.
- `conduit_key`: Indicates what conduit,
  if any, should be utilized as a source for token approvals when
  performing transfers. By default, i.e. when `conduit_key` is set to the
  zero hash, the `offerer` will grant ERC20, ERC721, and ERC1155 token
  approvals to Seaport directly so that it can perform any transfers
  specified by the order during fulfillment. In contrast, an `offerer`
  that elects to utilize a conduit will grant token approvals to the
  conduit contract corresponding to the supplied `conduit_key`, and
  Seaport will then instruct that conduit to transfer the respective
  tokens.

#### SignedOrder

A signed order ready for execution via Seaport.

```protobuf
message SignedOrder {
  Order parameters = 1;
  EthSignature signature = 2;
}
```

### API Services

#### Health

The Valorem Trade API uses
the [gRPC health checking protocol](https://github.com/grpc/grpc/blob/master/doc/health-checking.md)
to provide a general health check endpoint, as well as endpoints for each of the services.
Health checks for each service are available via `grpc.health.v1.Health`, queryable
by passing the Valorem service name `valorem.trade.v1.<service>`.

#### Reflection

The Valorem Trade API uses the [gRPC reflection protocol](https://github.com/grpc/grpc/blob/master/doc/server-reflection.md)
to provide service discovery and reflection. Reflection is available
via `grpc.reflection.v1alpha.ServerReflection`.

#### Auth service

The Authentication Service in Valorem Trade API enables users to authenticate
themselves via [Sign-In with Ethereum](https://docs.login.xyz/general-information/siwe-overview) (SIWE),
and receive the necessary credentials to access the other
services provided by the API. The Auth service uses session cookies to store
authentication information. Auth sessions are backed by
cryptographically signed cookies. These cookies are generated when they’re
not found or are otherwise invalid. When a valid, known cookie is received
in a request, the session is hydrated from this cookie. These cookies are validated
server-side. This provides "out-of-the-box" compatibility with both browser and
non-browser clients.

Non-browser clients must implement cookie storage and management themselves.

This service supports gRPC and gRPC-web clients.

```protobuf
service Auth {
    ...
}
```

##### Methods

###### `Nonce`

Returns an [EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) nonce for the
session and invalidates any existing session. This method resets session cookie,
which is passed back on the request.

```protobuf
rpc Nonce (Empty) returns (NonceText);
```

*Unary request*

```protobuf
message Empty {}
```

*Unary response*

`0 OK`

The request was successful, the response is an [EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) nonce as a `string`.

```protobuf
message NonceText {
  string nonce = 1;
}
```

- `nonce` (`string`): a randomized token typically chosen by the Trade API, and
  used to prevent replay attacks, at least 8 alphanumeric characters UTF-8 encoded as plaintext.

###### `Verify`

Verifies a valid SIWE message and returns the Ethereum address of the signer.
Upon successful verification, the Auth session is updated.

```protobuf
rpc Verify (VerifyText) returns (H160);
```

*Unary request*

```protobuf
message VerifyText {
  string body = 1;
}
```

- `body` (`string`): a JSON-encoded, signed, [EIP-191](https://eips.ethereum.org/EIPS/eip-191) signature scheme message.
  The message must contain the following
  string: `I accept the Valorem Terms of Service at https://app.valorem.xyz/tos and Privacy Policy at https://app.valorem.xyz/privacy`

Example signed and JSON encoded message:

```json
{
  "message": "app.valorem.xyz wants you to sign in with your Ethereum account:\n<wallet>\n\nI accept the Valorem Terms of Service at https://app.valorem.xyz/tos and Privacy Policy at https://app.valorem.xyz/privacy\n\nURI: https://app.valorem.xyz\nVersion: 1\nChain ID: 421614\nNonce: <nonce>\nIssued At: 2023-06-10T03:37:23.858Z",
  "signature": "<ECDSA signature signing the message>"
}
```

*Unary response*

`0 OK`

The request was successful, the response is the verified 160-bit address as an `H160`.

```protobuf
message H160 {
}
```

###### `Authenticate`

Checks if a given connection is authenticated and returns the authenticated
address for an Auth session.

```protobuf
rpc Authenticate (Empty) returns (H160);
```

Unary request*

```protobuf
message Empty {}
```

*Unary response*

`0 OK`

The request was successful, the response is the authenticated 160-bit address as an `H160`.

```protobuf
message H160 {
}

```

###### `Session`

Returns the SIWE session information for the request's session ID. This method provides access to details of the currently authenticated session.

```protobuf
rpc Session (Empty) returns (SiweSession);
```

*Unary request*

```protobuf
message Empty {}
```

*Unary response*

`0 OK`

The request was successful, the response is the `SiweSession` info.

```protobuf
message SiweSession {
  H160 address = 1;
  H256 chain_id = 2;
}
```

- `address` (`H160`): The Ethereum address of the authenticated user.
- `chain_id` (`H256`): The chain ID associated with the session.


###### `SignOut`

Invalidates the current session based on the request's session ID. This method is used to end an authenticated session, effectively signing out the user.

```protobuf
rpc SignOut (Empty) returns (Empty);
```

*Unary request*

```protobuf
rpc SignOut (Empty) returns (Empty);
```

*Unary response*

`0 OK`

The request was successful, and the session has been invalidated.

#### Fees

The Fees Service in Valorem Trade API provides information about the fees which
must be paid to use the API. The Fees service uses session cookies to store
authentication, and requires authentication to access because of fee tiers for
various users.

Non-browser clients must implement cookie storage and management themselves.

This service supports gRPC and gRPC-web clients.

```protobuf
service Fees {
    ...
}
```

##### Methods

###### `getFeeStructure`

Returns the `FeeStructure` for a user.

```protobuf
rpc getFeeStructure(Empty) returns (FeeStructure);
```

*Unary request*

```protobuf
message Empty {}
```

*Unary response*

`0 OK`

The request was successful, the response is the `FeeStructure` for the user.

```protobuf
message FeeStructure {
  TradeFees maker = 1;
  TradeFees taker = 2;
  int32 clear_write_notional_bps = 3;
  int32 clear_redeemed_notional_bps = 4;
  int32 clear_exercise_notional_bps = 5;
  H160 address = 6;
}
```

Fees expressed as positive integers, rebates are expressed as negative integers.

- `maker` (`TradeFees`): The fee or rebate for a maker.
- `taker` (`TradeFees`): The fee or rebate for a taker.
- `clear_write_notional_bps` (`int32`): A fee or rebate on notional value written via Clear expressed in basis points.
- `clear_redeemed_notional_bps` (`int32`): A fee or rebate on underlying asset notional value redeemed via Clear
  expressed in basis points.
- `clear_exercise_notional_bps` (`int32`): A fee or rebate on notional value exercised via Clear expressed in basis
  points.
- `address` (`H160`): The address fees must be paid to or rebates are received from.

```protobuf
message TradeFees {
  int32 notional_bps = 1;
  int32 premium_bps = 2;
  int32 spot_bps = 3;
  int32 flat = 4;
}
```

- `notional_bps` (`int32`): A fee or rebate on notional value traded expressed in basis points.
- `premium_bps` (`int32`): A fee or rebate on premium value traded expressed in basis points.
- `spot_bps` (`int32`): A fee or rebate on spot value traded expressed in basis points.
- `flat` (`int32`): A flat relayer fee or rebate expressed in 1e-6 USDC (dust) - used for non-valued
  offers/considerations such as NFTs.

#### RFQ

The RFQ (Request for Quote) service of the Valorem Trade API allows authenticated
takers to request quotes from makers, for those makers to respond with signed
offers, and for those traders to receive those signed offers for executing
trades on the Seaport smart contracts. It acts as a peer-to-peer signature relay.

```protobuf
service RFQ {
    ...
}
```

##### Trading Valorem Clear Options

These constraints must be followed to get a hard-quote for a Valorem Clear option via the RFQ:

- The `ItemType` must be `Erc1155`.
- The `token_address` must be `0x402A401B1944EBb5A3030F36Aa70d6b5794190c9`.
- The `identifier_or_criteria` must be the `optionId` of the long options token.
- The `amount` must not `None` and non-zero (i.e. you are looking to buy/sell options).
- The `action` must be `Buy` or `Sell`.
- The `seaport_address` must be set to seaport 1.5 (`0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`, which is version 1.5).
- The `chain_id` is supported (i.e. either Arbitrum One `42161`, or Arbitrum Sepolia `421614`).
- The given `optionId` is an `Option` and not a `Claim` or `None` (this is
  determined by calling the `token_type` function on the Clear contract).
- The given `optionId` exists (i.e., somebody has called `newOptionType` on the
  Clear contract to create the `optionId`).
- The maker supports the `exercise` and `underlying` tokens:
  - Presently for Arbitrum One: Native USDC (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`),
    and WETH (`0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`).
  - For testnet: USDC (`0x8AE0EeedD35DbEFe460Df12A20823eFDe9e03458`),
    MAGIC (`0xb795f8278458443f6C43806C020a84EB5109403c`),
    GMX (`0x5337deF26Da2506e08e37682b0d6E50b26a704BB`),
    WBTC (`0xf8Fe24D6Ea205dd5057aD2e5FE5e313AeFd52f2e`),
    WETH (`0x618b9a2Db0CF23Bb20A849dAa2963c72770C1372`),
    and LUSD (`0x42dED0b3d65510B5d1857bF26466b3b0b9e0BbbA`).

    __Note: The testnet tokens all have open mints__
- The `exercise`, `underlying` amounts are not `0`.
- For a `Buy`, it is not less than 30 minutes until the `expiry` of the `optionId`, and the `optionId` is not expired.
- USDC must be either the `underlying` or `exercise` asset.
- A maker must have the liquidity to support the option.

###### Fees

Responses from the RFQ service are subject to fees.
Fees are determined by the maker and taker `FeeStructure` from the [Fees service](#fees-service).
The fees must be included in the offer as follows:

For a long Valorem option buy:

- Two offer items:
  - the RFQ'd option long token in the correct quantity,
  - a maker fee/rebate in USDC (if any).
- Two consideration items:
  - the USDC premium debit,
  - a taker fee/rebate in USDC (if any).

For a long Valorem option sell:

- Two offer items:
  - the USDC premium credit,
  - a maker fee/rebate in USDC (if any).
- Two consideration items:
  - the RFQ option long token in the correct quantity,
  - a taker fee in fee/rebate in USDC (if any).

###### Authentication and authorization

Only authenticated and authorized users can access the RFQ service.

##### Methods

###### `Taker`

Request quotes from makers via a stream of `QuoteRequest` messages and receive
a stream of `QuoteResponse` messages.

```protobuf
rpc Taker (stream QuoteRequest) returns (stream QuoteResponse);
```

*Request stream*

```protobuf
message QuoteRequest {
  optional H128 ulid = 1;
  optional H160 taker_address = 2;
  ItemType item_type = 3;
  optional H160 token_address = 4;
  optional H256 identifier_or_criteria = 5;
  H256 amount = 6;
  Action action = 7;
  optional H256 chain_id = 8;
  optional H160 seaport_address = 9;
}
```

- `ulid` (`H128`, optional): The unique identifier for the quote request. This gets populated by the API.
- `taker_address` (`H160`, optional): The address of the taker, used to tailor an RFQ for the taker.
- `item_type` (`ItemType`): The type of item for which a quote is being requested.
- `token_address` (`H160`, optional): The token address for which a quote is being requested.
- `identifier_or_criteria` (`H256`, optional): The identifier or criteria for the item.
- `amount` (`H256`): The amount of the item.
- `action` (`Action`): The action (`BUY` or `SELL`) for the quote request.
- `chain_id` (`H256`, optional): The chain ID for the quote request. Must specify a supported chain.
  Supported chains are `[42161, 421614]`. Defaults to `421614`.
- `seaport_address` (`H160`, optional): The Seaport address for the quote request, defaults
  to `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`.

*Response stream*

```protobuf
message QuoteResponse {
  optional H128 ulid = 1;
  optional H160 maker_address = 2;
  SignedOrder order = 3;
  optional H256 chain_id = 4;
  optional H160 seaport_address = 5;
}
```

- `ulid` (`H128`, optional): The unique identifier for the quote request. This must match a quote request to be received by a taker.
- `maker_address` (`H160`, optional): The address of the maker making the offer.
- `order` (`SignedOrder`): The order and signature from the maker.
- `chain_id` (`H256`, optional): The chain ID for the offer. This must match the quote request chain ID. Defaults to the quote request chain ID matched by ulid.
- `seaport_address` (`H160`, optional): The Seaport address for the offer, defaults
  to `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`.

###### `Maker`

Send quotes to takers via a stream of `QuoteResponse` messages and receive a
stream of `QuoteRequest` messages.

```protobuf
rpc Maker (stream QuoteResponse) returns (stream QuoteRequest);
```

*Request stream*

```protobuf
message QuoteResponse {
  optional H128 ulid = 1;
  optional H160 maker_address = 2;
  SignedOrder order = 3;
  optional H256 chain_id = 4;
  optional H160 seaport_address = 5;
}
```

- `ulid` (`H128`, optional): The unique identifier for the quote request. This must match a quote request to be received by a taker.
- `maker_address` (`H160`, optional): The address of the maker making the offer.
- `order` (`SignedOrder`): The order and signature from the maker.
- `chain_id` (`H256`, optional): The chain ID for the offer. This must match the quote request chain ID. Defaults to the quote request chain ID matched by ulid.
- `seaport_address` (`H160`, optional): The Seaport address for the offer, defaults
  to `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`.

*Response stream*

```protobuf
message QuoteRequest {
  optional H128 ulid = 1;
  optional H160 taker_address = 2;
  ItemType item_type = 3;
  optional H160 token_address = 4;
  optional H256 identifier_or_criteria = 5;
  H256 amount = 6;
  Action action = 7;
  optional H256 chain_id = 8;
  optional H160 seaport_address = 9;
}
```

- `ulid` (`H128`, optional): The unique identifier for the quote request. This gets populated by the API.
- `taker_address` (`H160`, optional): The address of the taker, used to tailor an RFQ for the taker.
- `item_type` (`ItemType`): The type of item for which a quote is being requested.
- `token_address` (`H160`, optional): The token address for which a quote is being requested.
- `identifier_or_criteria` (`H256`, optional): The identifier or criteria for the item.
- `amount` (`H256`): The amount of the item.
- `action` (`Action`): The action (`BUY` or `SELL`) for the quote request.
- `chain_id` (`H256`, optional): The chain ID for the quote request. Must specify a supported chain.
  Supported chains are `[42161, 421614]`. Defaults to `421614`.
- `seaport_address` (`H160`, optional): The Seaport address for the quote request, defaults
  to `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`.

###### `WebTaker`

Quotes from makers via a unary `QuoteRequest` message and receive a stream
of `QuoteResponse` messages for use by gRPC-web clients such as browsers.

```protobuf
rpc WebTaker (QuoteRequest) returns (stream QuoteResponse);
```

*Unary request*

```protobuf
message QuoteRequest {
  optional H128 ulid = 1;
  optional H160 taker_address = 2;
  ItemType item_type = 3;
  H160 token_address = 4;
  optional H256 identifier_or_criteria = 5;
  H256 amount = 6;
  Action action = 7;
  optional H256 chain_id = 8;
  optional H160 seaport_address = 9;
}
```

- `ulid` (`H128`, optional): The unique identifier for the quote request. This gets populated by the API.
- `taker_address` (`H160`, optional): The address of the taker, used to tailor an RFQ for the taker.
- `item_type` (`ItemType`): The type of item for which a quote is being requested.
- `token_address` (`H160`, optional): The token address for which a quote is being requested.
- `identifier_or_criteria` (`H256`, optional): The identifier or criteria for the item.
- `amount` (`H256`): The amount of the item.
- `action` (`Action`): The action (`BUY` or `SELL`) for the quote request.
- `chain_id` (`H256`, optional): The chain ID for the quote request. Must specify a supported chain.
  Supported chains are `[42161, 421614]`. Defaults to `421614`.
- `seaport_address` (`H160`, optional): The Seaport address for the quote request, defaults
  to `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`.

*Response stream*

```protobuf
message QuoteResponse {
  optional H128 ulid = 1;
  optional H160 maker_address = 2;
  SignedOrder order = 3;
  optional H256 chain_id = 4;
  optional H160 seaport_address = 5;
}
```

- `ulid` (`H128`, optional): The unique identifier for the quote request. This must match a quote request to be received by a taker.
- `maker_address` (`H160`, optional): The address of the maker making the offer.
- `order` (`SignedOrder`): The order and signature from the maker.
- `chain_id` (`H256`, optional): The chain ID for the offer. This must match the quote request chain ID. Defaults to the quote request chain ID matched by ulid.
- `seaport_address` (`H160`, optional): The Seaport address for the offer, defaults
  to `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`.

#### Soft Quote

The Soft Quote service of the Valorem Trade API allows authenticated
takers to request soft-quotes from makers, for those makers to respond with offers at prices
with what would be expected with a hard-quote (`RFQ`).

```protobuf
service SoftQuote {
    ...
}
```

##### Quoting Valorem Clear Options

These constraints must be followed to get a soft-quote for a Valorem Clear option via the RFQ:

- The `token_address` must be `0x402A401B1944EBb5A3030F36Aa70d6b5794190c9`
- The `identifier_or_criteria` must be the `optionId` of the long options token.
- The `amount` must not `None` and non-zero (i.e. you are looking to buy/sell).
- The `chain_id` is supported (i.e. either Arbitrum One `42161`, or Arbitrum Goerli `421614`).
- The `action` is `Buy` or `Sell`.
- The given `optionId` is an `Option` and not a `Claim` or `None` (this is
  determined by calling the `token_type` function on the Clear contract).
- The given `optionId` exists (i.e., somebody has called `newOptionType` on the
  Clear contract to create the `optionId`).
- The maker supports the `exercise` and `underlying` tokens:
  - Presently for Arbitrum One: Native USDC (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`),
    and WETH (`0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`).
  - For Arbitrum One Goerli testnet: USDC (`0x8AE0EeedD35DbEFe460Df12A20823eFDe9e03458`),
    MAGIC (`0xb795f8278458443f6C43806C020a84EB5109403c`),
    GMX (`0x5337deF26Da2506e08e37682b0d6E50b26a704BB`),
    WBTC (`0xf8Fe24D6Ea205dd5057aD2e5FE5e313AeFd52f2e`),
    WETH (`0x618b9a2Db0CF23Bb20A849dAa2963c72770C1372`),
    and LUSD (`0x42dED0b3d65510B5d1857bF26466b3b0b9e0BbbA`).

    __Note: The testnet tokens all have open mints__
- The `exercise`, `underlying` amounts are not `0`.
- For a `Buy`, it is not less than 30 minutes until the `expiry` of the `optionId`, and the `optionId` is not expired.
- USDC must be either the `underlying` or `exercise` asset.

###### Fees

The soft-quote needs to consider fees as per the `RFQ`.

##### Authentication and authorization

Only authenticated and authorized users can access the RFQ service.

##### Methods

###### `Taker`

Request quotes from makers via a stream of `QuoteRequest` messages and receive
a stream of `SoftQuoteResponse` messages.

```protobuf
rpc Taker (stream QuoteRequest) returns (stream SoftQuoteResponse);
```

*Request stream*

```protobuf
message QuoteRequest {
  optional H128 ulid = 1;
  optional H160 taker_address = 2;
  ItemType item_type = 3;
  optional H160 token_address = 4;
  optional H256 identifier_or_criteria = 5;
  H256 amount = 6;
  Action action = 7;
  optional H256 chain_id = 8;
  optional H160 seaport_address = 9;
}
```

- `ulid` (`H128`, optional): The unique identifier for the quote request. This gets populated by the API.
- `taker_address` (`H160`, optional): The address of the taker, used to tailor an RFQ for the taker.
- `item_type` (`ItemType`): The type of item for which a quote is being requested.
- `token_address` (`H160`, optional): The token address for which a quote is being requested.
- `identifier_or_criteria` (`H256`, optional): The identifier or criteria for the item.
- `amount` (`H256`): The amount of the item.
- `action` (`Action`): The action (`BUY` or `SELL`) for the quote request.
- `chain_id` (`H256`, optional): The chain ID for the quote request. Must specify a supported chain.
  Supported chains are `[42161, 421614]`. Defaults to `421614`.
- `seaport_address` (`H160`, optional): The Seaport address for the quote request, defaults
  to `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`.

*Response stream*

```protobuf
message SoftQuoteResponse {
  optional H128 ulid = 1;
  optional H160 maker_address = 2;
  Order order = 3;
  optional H256 chain_id = 4;
  optional H160 seaport_address = 5;
}
```

- `ulid` (`H128`, optional): The unique identifier for the quote request. This must match a quote request to be received by a taker.
- `maker_address` (`H160`, optional): The address of the maker making the offer.
- `order` (`Order`): The order from the maker.
- `chain_id` (`H256`, optional): The chain ID for the offer. This must match the quote request chain ID. Defaults to the quote request chain ID matched by ulid.
- `seaport_address` (`H160`, optional): The Seaport address for the offer, defaults
  to `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`.

###### `Maker`

Send quotes to takers via a stream of `SoftQuoteResponse` messages and receive a
stream of `QuoteRequest` messages.

```protobuf
rpc Maker (stream SoftQuoteResponse) returns (stream QuoteRequest);
```

*Request stream*

```protobuf
message SoftQuoteResponse {
  optional H128 ulid = 1;
  optional H160 maker_address = 2;
  Order order = 3;
  optional H256 chain_id = 4;
  optional H160 seaport_address = 5;
}
```

- `ulid` (`H128`, optional): The unique identifier for the quote request. This must match a quote request to be received by a taker.
- `maker_address` (`H160`, optional): The address of the maker making the offer.
- `order` (`Order`): The order from the maker.
- `chain_id` (`H256`, optional): The chain ID for the offer. This must match the quote request chain ID. Defaults to the quote request chain ID matched by ulid.
- `seaport_address` (`H160`, optional): The Seaport address for the offer, defaults
  to `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`.

*Response stream*

```protobuf
message QuoteRequest {
  optional H128 ulid = 1;
  optional H160 taker_address = 2;
  ItemType item_type = 3;
  optional H160 token_address = 4;
  optional H256 identifier_or_criteria = 5;
  H256 amount = 6;
  Action action = 7;
  optional H256 chain_id = 8;
  optional H160 seaport_address = 9;
}
```

- `ulid` (`H128`, optional): The unique identifier for the quote request. This gets populated by the API.
- `taker_address` (`H160`, optional): The address of the taker, used to tailor an RFQ for the taker.
- `item_type` (`ItemType`): The type of item for which a quote is being requested.
- `token_address` (`H160`, optional): The token address for which a quote is being requested.
- `identifier_or_criteria` (`H256`, optional): The identifier or criteria for the item.
- `amount` (`H256`): The amount of the item.
- `action` (`Action`): The action (`BUY` or `SELL`) for the quote request.
- `chain_id` (`H256`, optional): The chain ID for the quote request. Must specify a supported chain.
  Supported chains are `[42161, 421614]`. Defaults to `421614`.
- `seaport_address` (`H160`, optional): The Seaport address for the quote request, defaults
  to `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`.

###### `WebTaker`

Quotes from makers via a unary `QuoteRequest` message and receive a stream
of `SoftQuoteResponse` messages for use by gRPC-web clients such as browsers.

```protobuf
rpc WebTaker (QuoteRequest) returns (stream SoftQuoteResponse);
```

*Unary request*

```protobuf
message QuoteRequest {
  optional H128 ulid = 1;
  optional H160 taker_address = 2;
  ItemType item_type = 3;
  H160 token_address = 4;
  optional H256 identifier_or_criteria = 5;
  H256 amount = 6;
  Action action = 7;
  optional H256 chain_id = 8;
  optional H160 seaport_address = 9;
}
```

- `ulid` (`H128`, optional): The unique identifier for the quote request. This gets populated by the API.
- `taker_address` (`H160`, optional): The address of the taker, used to tailor an RFQ for the taker.
- `item_type` (`ItemType`): The type of item for which a quote is being requested.
- `token_address` (`H160`, optional): The token address for which a quote is being requested.
- `identifier_or_criteria` (`H256`, optional): The identifier or criteria for the item.
- `amount` (`H256`): The amount of the item.
- `action` (`Action`): The action (`BUY` or `SELL`) for the quote request.
- `chain_id` (`H256`, optional): The chain ID for the quote request. Must specify a supported chain.
  Supported chains are `[42161, 421614]`. Defaults to `421614`.
- `seaport_address` (`H160`, optional): The Seaport address for the quote request, defaults
  to `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`.

*Response stream*

```protobuf
message SoftQuoteResponse {
  optional H128 ulid = 1;
  optional H160 maker_address = 2;
  Order order = 3;
  optional H256 chain_id = 4;
  optional H160 seaport_address = 5;
}
```

- `ulid` (`H128`, optional): The unique identifier for the quote request. This must match a quote request to be received by a taker.
- `maker_address` (`H160`, optional): The address of the maker making the offer.
- `order` (`Order`): The order from the maker.
- `chain_id` (`H256`, optional): The chain ID for the offer. This must match the quote request chain ID. Defaults to the quote request chain ID matched by ulid.
- `seaport_address` (`H160`, optional): The Seaport address for the offer, defaults
  to `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`.
