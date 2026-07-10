import { describe, expect, test } from "bun:test";
import { isPrivateIp, parsePublicHttpUrl, PublicWebError } from "../src/services/public-web";

describe("public web protection", () => {
  test("blocks private IPv4 ranges", () => {
    expect(isPrivateIp("127.0.0.1")).toBeTrue();
    expect(isPrivateIp("10.20.30.40")).toBeTrue();
    expect(isPrivateIp("192.168.1.1")).toBeTrue();
    expect(isPrivateIp("8.8.8.8")).toBeFalse();
  });

  test("blocks local and non-http URLs", () => {
    expect(() => parsePublicHttpUrl("http://localhost/admin")).toThrow(PublicWebError);
    expect(() => parsePublicHttpUrl("file:///etc/passwd")).toThrow(PublicWebError);
  });

  test("removes embedded credentials", () => {
    const url = parsePublicHttpUrl("https://user:secret@example.com/path");
    expect(url.username).toBe("");
    expect(url.password).toBe("");
  });
});

