import { describe, expect, test } from "bun:test";
import {
  RequestBodyTooLargeError,
  readBoundedJson,
} from "../src/http/bounded-json";

describe("bounded JSON request reader", () => {
  test("bounds chunked bodies with no declared length", async () => {
    const request = new Request("http://openbot.test", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"value":"'));
          controller.enqueue(new Uint8Array(100));
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      }),
    });
    await expect(readBoundedJson(request, 32)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  test("does not trust an understated Content-Length", async () => {
    const request = new Request("http://openbot.test", {
      method: "POST",
      headers: { "content-length": "2" },
      body: JSON.stringify({ value: "too long" }),
    });
    await expect(readBoundedJson(request, 8)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });
});
