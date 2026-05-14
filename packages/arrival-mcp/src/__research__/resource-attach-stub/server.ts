/**
 * Day -1 verification spike for the arrival-resources proposal.
 *
 * Standalone MCP server exposing ONE hardcoded resource. Purpose: verify that
 * Claude Desktop (or any other MCP client) actually injects resource content
 * into the conversation context when a human attaches via @-mention.
 *
 * Pass criterion: attach the resource in Claude Desktop, send a message that
 * references it, observe the resource JSON visibly land in the prompt context.
 * Fail criterion: anything else (silent ignore, error, content not visible).
 *
 * If this fails, defer the entire arrival-resources proposal.
 *
 * Run protocol: see ./README.md.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import invariant from "tiny-invariant";

const FAKE_ENTITY_URI = "https://arrival.here.build/project/test/entity/card";

const FAKE_ENTITY_BODY = JSON.stringify(
  {
    uuid: "card-fake-uuid",
    type: "TplComponent",
    name: "Card",
    tplTree: {
      uuid: "root-fake-uuid",
      type: "TplTag",
      tag: "div",
      children: [],
    },
  },
  null,
  2,
);

const MIME = "application/vnd.here-build.arrival.entity+json; v=1";

const server = new Server({ name: "arrival-resources-spike", version: "0.0.0" }, { capabilities: { resources: {} } });

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: FAKE_ENTITY_URI,
      name: "Card (spike test resource)",
      description: "Hardcoded Plexus entity for day -1 attach verification",
      mimeType: MIME,
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  invariant(req.params.uri === FAKE_ENTITY_URI, `Unknown resource URI: ${req.params.uri}`);
  return {
    contents: [
      {
        uri: FAKE_ENTITY_URI,
        mimeType: MIME,
        text: FAKE_ENTITY_BODY,
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Server keeps running on stdio; MCP client manages lifecycle.
