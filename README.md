# vue-tsc-files

A tiny tool to run `vue-tsc` on specific files without ignoring `tsconfig.json`.

Ported from [tsc-files](https://github.com/gustavopch/tsc-files).

## Installation

```sh
npm i -D @whiter001/vue-tsc-files
```

```sh
pnpm add -D @whiter001/vue-tsc-files
```

`vue-tsc` and `typescript` are peer dependencies, install the versions matching your project:

```sh
pnpm add -D vue-tsc typescript
```

## Why

I wanted to type-check **only the staged files** with [lint-staged](https://github.com/okonet/lint-staged).

## Usage

With lint-staged:

```json
{
  "lint-staged": {
    "**/*.{vue,ts,tsx}": "vue-tsc-files"
  }
}
```

## pnpm support

Works with npm and pnpm. The CLI locates the installed `vue-tsc` package via `require.resolve` and executes its JS entry with the current Node binary, so pnpm's symlinked `node_modules` layout is fully supported.

A failed type check (or a failed spawn) always exits with a non-zero code.

## Sidenotes

Flag "--noEmit" is always passed to underlying `vue-tsc` by default.

`vue-tsc-files` passes module declarations and namespaces from `d.ts` files to `vue-tsc`, so please make sure that needed declarations are inside `d.ts` files. The `d.ts` scan skips `node_modules`, dot directories (`.git`, `.github`, ...) and common build outputs (`dist`, `build`, `out`, `coverage`).

```javascript
// example.d.ts
declare module "@vue/runtime-core" {
  interface ComponentCustomProperties {
    $custom: MyCustomType;
  }
}
```

## Development

Requires Node >= 22.18 (tests rely on built-in TypeScript type stripping).

```sh
pnpm install
pnpm build      # rolldown → bin/cli.js
pnpm check      # oxlint + oxfmt --check + tsc --noEmit
pnpm test       # node:test unit + integration tests
```

## License

Released under the [MIT License](./LICENSE).
