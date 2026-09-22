// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// Let Node import the IDL the way webpack does.
//
// `program.ts` has `import idl from "./soladrome.json"`. Webpack accepts it; Node requires an
// import attribute (`with { type: "json" }`) and refuses otherwise. Adding the attribute to
// the app source to suit a terminal script would be the tail wagging the dog, so the script
// supplies the attribute instead — nothing in the app changes.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(pathToFileURL(new URL("./json-hook.mjs", import.meta.url).pathname));
