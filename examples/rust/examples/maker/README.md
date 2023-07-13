## Running the example

First copy the template config file `settings.yaml.template` and rename to `settings.yaml`, then fill in the relavent fields.

The default settings is using the CA root for trade.valorem.xyz (located at the project root, `certs/trade.valorem.xyz.pem`).

Then run the example like so:

```bash
cargo run --example maker examples/maker/settings.yaml
```
