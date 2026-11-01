declare module '*?raw' {
  const text: string
  export default text
}

declare module '*.wasm' {
  const bytes: Uint8Array<ArrayBuffer>
  export default bytes
}
