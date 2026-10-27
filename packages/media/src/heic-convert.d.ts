declare module "heic-convert" {
  interface ConvertOptions {
    buffer: Buffer | ArrayBuffer | Uint8Array;
    format: "PNG" | "JPEG";
    quality?: number;
  }
  function convert(opts: ConvertOptions): Promise<ArrayBuffer | Buffer>;
  export default convert;
}
