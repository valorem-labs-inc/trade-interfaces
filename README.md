# Valorem Trade Interfaces

This repository contains API interfaces.


Valorem Trade uses gRPC services and protobuf to achieve fast and efficient communication. This repository contains the protobuf definitions and related documentation.

Of particular interest is the protobuf wire format for the [Seaport](https://github.com/ProjectOpenSea/seaport) marketplace, which underlies the Valorem exchange.


## Getting Started

Install dependancies
```bash
yarn install
```

Generate code from protobuf files using [Buf](https://www.npmjs.com/package/@bufbuild/buf), a modern replacement for Google's protobuf compiler.
```
npx buf generate proto
```
