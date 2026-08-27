import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type MediaUploadDependencies = {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  put?: (input: {
    url: URL;
    address: ResolvedAddress;
    contentType: string;
    bytes: Uint8Array;
  }) => Promise<number>;
};

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const value = address.toLowerCase();
  if (value.startsWith("::ffff:")) return publicAddress(value.slice(7));
  return !(
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value)
  );
}

async function defaultPut(input: {
  url: URL;
  address: ResolvedAddress;
  contentType: string;
  bytes: Uint8Array;
}) {
  return await new Promise<number>((resolve, reject) => {
    const req = httpsRequest(
      input.url,
      {
        method: "PUT",
        headers: {
          "content-type": input.contentType,
          "content-length": input.bytes.byteLength,
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, input.address.address, input.address.family),
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.setTimeout(30_000, () =>
      req.destroy(new Error("Media upload timed out.")),
    );
    req.once("error", reject);
    req.end(input.bytes);
  });
}

export async function uploadPresignedMedia(
  file: File,
  uploadUrl: string,
  dependencies: MediaUploadDependencies = {},
) {
  const url = new URL(uploadUrl);
  if (url.protocol !== "https:") throw new Error("Unsafe media upload URL.");
  const resolveHost =
    dependencies.resolve ??
    (async (hostname) =>
      (await lookup(hostname, {
        all: true,
        verbatim: true,
      })) as ResolvedAddress[]);
  const addresses = await resolveHost(url.hostname);
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !publicAddress(address))
  ) {
    throw new Error("Unsafe media upload address.");
  }
  const status = await (dependencies.put ?? defaultPut)({
    url,
    address: addresses[0] as ResolvedAddress,
    contentType: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
  });
  // Redirects are deliberately refused; the validated address is the only network target.
  if (status < 200 || status >= 300)
    throw new Error(`Typefully media upload failed (${status}).`);
}
