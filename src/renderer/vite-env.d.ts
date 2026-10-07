/// <reference types="vite/client" />

declare module '*.woff2?dataurl' {
  const url: string
  export default url
}

declare module '*.wasm?dataurl' {
  const url: string
  export default url
}
