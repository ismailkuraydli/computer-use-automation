/**
 * Imported first by the MCP server: stdout carries the MCP protocol, so any
 * console.log from the engine, the agent loop or a dependency goes to stderr.
 */

console.log = console.error;
console.info = console.error;
console.debug = console.error;

export {};
