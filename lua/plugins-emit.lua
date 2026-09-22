#!/usr/bin/env lua
-- Loads a plugins.lua manifest and prints its enabled specs as JSON.
--
-- Manifest contract: the file returns an array where each entry is either
-- a bare source string ("npm:@scope/pkg") or a table
-- { source = "...", enabled = true|false }. Entries with enabled = false
-- are declared but treated as absent by the sync (they won't be installed,
-- and will be removed if previously installed by the manager).
--
-- argv: manifest_path

local manifest_path = arg[1]
if not manifest_path then
	io.stderr:write("usage: plugins-emit.lua <manifest_path>\n")
	os.exit(1)
end

local chunk, load_err = loadfile(manifest_path)
if not chunk then
	io.stderr:write("failed to load manifest: " .. tostring(load_err) .. "\n")
	os.exit(1)
end

local ok, specs = pcall(chunk)
if not ok then
	io.stderr:write("manifest error: " .. tostring(specs) .. "\n")
	os.exit(1)
end
specs = specs or {}

local function json_string(s)
	s = tostring(s)
	s = s:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n")
	return '"' .. s .. '"'
end

local parts = {}
for _, entry in ipairs(specs) do
	local spec = type(entry) == "string" and { source = entry } or entry
	if spec.source and spec.enabled ~= false then
		table.insert(parts, '{"source":' .. json_string(spec.source) .. "}")
	end
end

print("[" .. table.concat(parts, ",") .. "]")
