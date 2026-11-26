# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```

You can also install [eslint-plugin-react-x](https://npmx.dev/package/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://npmx.dev/package/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```
# Devnet ticket registration

The organiser attendee page can register an existing issued ticket with the deployed Anchor program. It submits `create_event` (only if the event PDA does not exist) followed by `register_ticket` in one Devnet transaction. The wallet connected in the organiser header signs and pays the Devnet fee; the attendee’s public wallet address is the initial on-chain owner.

The app uses the generated Anchor IDL at `src/idl/nodara_tickets.json`, pinned to program `CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf` and Solana Devnet. A mismatched `VITE_SOLANA_PROGRAM_ID` is rejected. Never enter a seed phrase or private key in NODARA.

## Required Supabase setup

The existing `202611260003_solana_ticketing.sql` migration provides the chain metadata columns and prevents authenticated clients from writing them. Apply that migration if it is not already applied. No new database migration is needed for this workflow.

Deploy the trusted transaction verifier from the repository root with the Supabase CLI:

```sh
supabase functions deploy verify-solana-ticket --project-ref tpoxqdgbwichiikygndw
```

The function uses Supabase’s server-side `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` environment values; never copy the service role key into the frontend or a Vite environment file. The function validates the signed, confirmed Devnet transaction, IDL discriminators, account addresses and account state, Supabase session, event organiser ownership and ticket booking eligibility before writing `verified` status. The write is server-side only. Set `SOLANA_DEVNET_RPC_URL` as a Supabase Function secret only if using a dedicated Devnet RPC; it must resolve to Devnet.

## Organiser steps

1. Sign in, open the event’s Attendees page and connect a wallet that supports Wallet Standard transaction signing on Devnet.
2. Use a Devnet wallet with enough Devnet SOL for transaction fees and account rent.
3. For an issued ticket, enter the attendee’s public Solana wallet address and choose **Register on Devnet**.
4. Approve the transaction in the wallet. NODARA waits for Devnet confirmation and then asks the verifier function to confirm the transaction and account state.
5. If the transaction confirms but server verification is temporarily unavailable, the page keeps the public signature and account addresses in local storage and offers **Retry server verification**. The ticket remains unverified in Supabase until the server confirms it.

## Controlled ticket transfers

After an issued ticket has `blockchain_status = 'verified'`, its current on-chain owner can submit the deployed `transfer_ticket` instruction from **My tickets**. The client derives the event, ticket and transfer receipt PDAs from the Anchor source/IDL, simulates the instruction, shows the result and asks for explicit confirmation before opening the wallet signature request.

The server-side `verify-solana-transfer` function independently validates the confirmed Devnet instruction, signer, current sender, recipient, receipt PDA and resulting account state. It calls the service-role-only `record_verified_ticket_transfer` SQL function, which writes transfer history, changes the wallet address, rotates the QR token and clears the old NODARA holder in one transaction. The former holder loses ticket-table/RPC access immediately.

The recipient enters the ticket UUID shared by the sender, connects the destination wallet, and signs a message bound to that wallet, ticket and NODARA user. `claim-transferred-ticket` verifies the wallet signature and current Devnet owner before assigning the NODARA holder. No SOL is required for this message signature. The recipient’s ticket and new QR then appear in My tickets.

### Transfer setup

Apply `supabase/migrations/202611260004_controlled_transfers.sql` after migrations `202611260002_ticketing.sql` and `202611260003_solana_ticketing.sql`. It adds the current-holder field, protects it behind server functions, updates ticket RLS and `get_my_tickets`, adds atomic transfer/claim RPCs, and rotates QR access on transfer. It does not remove existing ticket or booking data.

Deploy both server functions:

```sh
supabase functions deploy verify-solana-transfer --project-ref tpoxqdgbwichiikygndw
supabase functions deploy claim-transferred-ticket --project-ref tpoxqdgbwichiikygndw
```

Both use Supabase’s server-side service-role environment value. Never put it in Vite variables or browser code. They verify Devnet’s genesis hash and the fixed program ID. The recipient must claim the ticket before it becomes available in their NODARA account; the sender should share the ticket UUID, never the QR secret.

Transfers remain subject to the on-chain event’s `transfers_allowed` flag and the program’s valid/not-checked-in checks. The program’s current event creation default is disabled; this UI does not expose a transfer-policy toggle. Transfer and check-in are separate; this phase does not add blockchain check-in.
