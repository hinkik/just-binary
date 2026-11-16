import { describe, expect, it } from "vitest";
import {
  EnvMap,
  encode,
  envGet,
  envIntegerSuffixes,
  envKeysWithPrefix,
  envSet,
} from "./bytes.js";

describe("EnvMap", () => {
  it("keeps the Map<string, Uint8Array> contract", () => {
    const env = new EnvMap();
    env.setText("a", "one");
    env.set("b", encode("two"));
    expect(Array.from(env.get("a") as Uint8Array)).toEqual([111, 110, 101]);
    expect(env.getText("b")).toBe("two");
    expect(env.size).toBe(2);
    expect(Array.from(env.keys())).toEqual(["a", "b"]);
    expect(Array.from(new Map(env).keys())).toEqual(["a", "b"]);
    expect(env.delete("a")).toBe(true);
    expect(env.has("a")).toBe(false);
    expect(envGet(env, "a", "fallback")).toBe("fallback");
  });

  it("reports text as inexact for bytes that are not valid UTF-8", () => {
    const env = new EnvMap();
    env.set("bin", new Uint8Array([0xff, 0x41]));
    env.set("text", encode("héllo"));
    expect(env.getExactText("bin")).toBeNull();
    expect(env.getExactText("text")).toBe("héllo");
    expect(env.getExactText("unset")).toBeUndefined();
    expect(Array.from(env.get("bin") as Uint8Array)).toEqual([0xff, 0x41]);
  });

  it("clones independently", () => {
    const env = new EnvMap();
    envSet(env, "x", "1");
    const copy = env.clone();
    envSet(copy, "x", "2");
    envSet(copy, "y", "3");
    expect([envGet(env, "x"), env.has("y"), envGet(copy, "x")]).toEqual([
      "1",
      false,
      "2",
    ]);
  });

  it("tracks keys by prefix through sets and deletes", () => {
    const env = new EnvMap();
    envSet(env, "arr_0", "a");
    envSet(env, "arr_2", "c");
    envSet(env, "arr__length", "3");
    envSet(env, "arrx", "no");
    expect(envIntegerSuffixes(env, "arr_")).toEqual([0, 2]);
    envSet(env, "arr_1", "b");
    envSet(env, "arr_10", "k");
    expect(envIntegerSuffixes(env, "arr_")).toEqual([0, 1, 2, 10]);
    env.delete("arr_10");
    env.delete("arr_0");
    expect(envIntegerSuffixes(env, "arr_")).toEqual([1, 2]);
    expect(envKeysWithPrefix(env, "arr_").sort()).toEqual([
      "arr_1",
      "arr_2",
      "arr__length",
    ]);
    // A copy rebuilds its own index.
    const copy = env.clone();
    copy.delete("arr_1");
    expect(envIntegerSuffixes(copy, "arr_")).toEqual([2]);
    expect(envIntegerSuffixes(env, "arr_")).toEqual([1, 2]);
    // The plain-Map fallback gives the same answers.
    expect(envIntegerSuffixes(new Map(env), "arr_")).toEqual([1, 2]);
  });
});
