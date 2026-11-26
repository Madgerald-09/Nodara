# NODARA ticket program

Anchor 0.30.1 program source for Devnet deployment. The configured program address is `CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf`. Anchor generated its matching deployment keypair locally at `target/deploy/nodara_tickets-keypair.json`; that path is ignored by Git. The program has not been deployed.

## Build and test

This project uses Anchor CLI 0.30.1 and Solana CLI/SBF tools 1.18.17. The installed SBF compiler is Rust 1.75. Anchor 0.30 IDL generation also needs the installed `nightly-2024-06-10` host toolchain because its IDL macro uses the older `proc_macro2::Span::source_file` API. The root Cargo lockfile pins Rust-1.75-compatible dependencies; keep it committed and avoid regenerating it with an unpinned `cargo update`.

Create a disposable local test payer (never use a Mainnet or Devnet wallet for validator tests):

```sh
solana-keygen new --silent --no-bip39-passphrase \
  --outfile "$HOME/.config/solana/nodara-localnet-test.json"
```

Then run the actual Anchor SBF/IDL build and validator-backed integration tests:

```sh
RUSTUP_TOOLCHAIN=nightly-2024-06-10 anchor build
RUSTUP_TOOLCHAIN=nightly-2024-06-10 anchor test \
  --provider.cluster localnet \
  --provider.wallet "$HOME/.config/solana/nodara-localnet-test.json"
```

`anchor test` starts its own local validator and loads the built program. Port 8899 must be free. If it is occupied, stop your own validator or use an isolated validator port and run the configured Mocha suite with `ANCHOR_PROVIDER_URL`, `ANCHOR_WALLET`, and a locally funded disposable test payer. The test suite covers organiser issuance, unauthorized and duplicate issuance, allowed and forbidden transfers, event transfer restrictions, successful and duplicate check-in, invalidation, and rejection after invalidation.

## Devnet deployment

Use separate local wallets for the program deployment key and Devnet fee payer. Never commit, upload, or share either private key or its seed phrase. `target/deploy/nodara_tickets-keypair.json` is ignored and is required to deploy this exact program address. Keep it in secure local storage. If it is lost, create a new deployment keypair locally and run `anchor keys sync`; this changes the public program ID in the source and both Anchor cluster entries, so rebuild and re-test before deployment.

Create a dedicated Devnet fee payer locally:

```sh
solana-keygen new --outfile "$HOME/.config/solana/nodara-devnet.json"
```

After confirming the key files are safely stored and the Devnet wallet has faucet SOL, deploy only with an explicit Devnet override:

```sh
RUSTUP_TOOLCHAIN=nightly-2024-06-10 anchor build
RUSTUP_TOOLCHAIN=nightly-2024-06-10 anchor deploy \
  --provider.cluster devnet \
  --provider.wallet "$HOME/.config/solana/nodara-devnet.json"
```

Do not change the workspace default from Localnet. These instructions do not deploy the program or enable frontend ticket transactions.

## Program model and trust boundary

- Event PDA seeds: `event`, 16-byte NODARA event UUID.
- Ticket PDA seeds: `ticket`, event PDA, 16-byte NODARA ticket UUID.
- Transfer receipt PDA seeds: `transfer`, ticket PDA, little-endian `u32` sequence.
- Only the event organiser can register, change transfer policy, check in, or invalidate tickets. Ticket initialization makes a duplicate event/ticket pair fail.
- Only the current ticket owner can transfer. The event flag must allow it; invalid or checked-in tickets cannot transfer. Each transfer creates a receipt account.
- The organiser is the issuance authority. The program cannot query Supabase, so the application/backend must verify a confirmed booking before presenting registration. The program itself does not prove payment or booking eligibility.
- On-chain state contains public keys, UUIDs, validity/check-in flags and counters only; no personal information or QR tokens.
