import { lauxlib, lua, lualib, to_luastring } from "fengari";
import type { EvalClient } from "@/lib/session/redis-store";

/**
 * Offline Redis double that EXECUTES the adapter's real Lua scripts in a Lua VM
 * (fengari) against an in-memory keyspace, with a `redis.call` shim for the
 * commands those scripts use. Like Redis, each EVAL runs to completion without
 * interleaving. This verifies script logic and argument marshalling; it does
 * not prove Upstash network behaviour.
 */
type Entry = { hash: Map<string, string>; expireAt: number | null };

export type LuaRedis = EvalClient & {
  evalCount: number;
  keys(): string[];
  raw(key: string): Record<string, string> | null;
};

export function createLuaRedis(now: () => number = Date.now): LuaRedis {
  const db = new Map<string, Entry>();

  const entry = (key: string): Entry | undefined => {
    const e = db.get(key);
    if (e && e.expireAt !== null && now() >= e.expireAt) {
      db.delete(key);
      return undefined;
    }
    return e;
  };

  function call(L: unknown): number {
    const n = lua.lua_gettop(L);
    const args: string[] = [];
    for (let i = 1; i <= n; i++) args.push(lua.lua_tojsstring(L, i));
    const [cmd, key, ...rest] = args;
    switch (cmd?.toUpperCase()) {
      case "EXISTS":
        lua.lua_pushinteger(L, entry(key!) ? 1 : 0);
        return 1;
      case "HSET": {
        const e = entry(key!) ?? { hash: new Map(), expireAt: null };
        let added = 0;
        for (let i = 0; i + 1 < rest.length; i += 2) {
          if (!e.hash.has(rest[i]!)) added++;
          e.hash.set(rest[i]!, rest[i + 1]!);
        }
        db.set(key!, e);
        lua.lua_pushinteger(L, added);
        return 1;
      }
      case "HMGET": {
        const e = entry(key!);
        lua.lua_createtable(L, rest.length, 0);
        rest.forEach((field, i) => {
          const v = e?.hash.get(field);
          if (v === undefined) lua.lua_pushboolean(L, false); // Redis nil bulk -> Lua false
          else lua.lua_pushstring(L, to_luastring(v));
          lua.lua_rawseti(L, -2, i + 1);
        });
        return 1;
      }
      case "PEXPIREAT": {
        const e = entry(key!);
        if (e) e.expireAt = Number(rest[0]);
        lua.lua_pushinteger(L, e ? 1 : 0);
        return 1;
      }
      case "DEL":
        lua.lua_pushinteger(L, db.delete(key!) ? 1 : 0);
        return 1;
      default:
        return lauxlib.luaL_error(L, to_luastring(`unsupported command ${cmd}`));
    }
  }

  function pushArray(L: unknown, name: string, values: string[]) {
    lua.lua_createtable(L, values.length, 0);
    values.forEach((v, i) => {
      lua.lua_pushstring(L, to_luastring(v));
      lua.lua_rawseti(L, -2, i + 1);
    });
    lua.lua_setglobal(L, to_luastring(name));
  }

  function toJs(L: unknown, idx: number): unknown {
    const t = lua.lua_type(L, idx);
    if (t === lua.LUA_TSTRING) return lua.lua_tojsstring(L, idx);
    if (t === lua.LUA_TNUMBER) return lua.lua_tonumber(L, idx);
    if (t === lua.LUA_TTABLE) {
      const out: unknown[] = [];
      const len = lua.lua_rawlen(L, idx);
      for (let i = 1; i <= len; i++) {
        lua.lua_rawgeti(L, idx, i);
        out.push(toJs(L, -1));
        lua.lua_pop(L, 1);
      }
      return out;
    }
    return null; // nil / false
  }

  const client: LuaRedis = {
    evalCount: 0,
    async eval<TArgs extends unknown[], TData = unknown>(script: string, keys: string[], args: TArgs): Promise<TData> {
      client.evalCount++;
      const L = lauxlib.luaL_newstate();
      lualib.luaL_openlibs(L);
      lua.lua_createtable(L, 0, 1);
      lua.lua_pushjsfunction(L, call);
      lua.lua_setfield(L, -2, to_luastring("call"));
      lua.lua_setglobal(L, to_luastring("redis"));
      pushArray(L, "KEYS", keys);
      pushArray(L, "ARGV", args.map(String));
      if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== lua.LUA_OK || lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
        throw new Error(`Lua error: ${lua.lua_tojsstring(L, -1)}`);
      }
      return toJs(L, -1) as TData;
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (db.delete(k)) n++;
      return n;
    },
    keys: () => [...db.keys()].filter((k) => entry(k)),
    raw: (key) => {
      const e = entry(key);
      return e ? Object.fromEntries(e.hash) : null;
    },
  };
  return client;
}
