#!/usr/bin/env node
/**
 * ai-wiki CLI — AI Agent 协作知识库
 */

const { main } = require("../lib/commands");
main(process.argv.slice(2));
