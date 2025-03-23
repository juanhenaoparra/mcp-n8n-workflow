#!/usr/bin/env node

/**
 * MCP server for managing N8N workflows.
 * Provides tools to list, create, update and manage workflow executions.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import fs from "fs";
// Environment configuration
const N8N_HOST = process.env.N8N_HOST || "http://localhost:5678";
const N8N_API_KEY = process.env.N8N_API_KEY || "n8n";

if (!N8N_HOST || !N8N_API_KEY) {
  throw new Error('N8N_HOST and N8N_API_KEY environment variables are required');
}

// Types for N8N workflows
interface N8NWorkflow {
  id: number;
  name: string;
  active: boolean;
  nodes: any[];
  connections: any;
}

interface N8NWorkflowExecution {
  id: string;
  finished: boolean;
  mode: string;
  startedAt: string;
  stoppedAt?: string;
  status: string;
}

/**
 * Type alias for a note object.
 */
type Note = { title: string, content: string };

/**
 * Simple in-memory storage for notes.
 * In a real implementation, this would likely be backed by a database.
 */
const notes: { [id: string]: Note } = {
  "1": { title: "First Note", content: "This is note 1" },
  "2": { title: "Second Note", content: "This is note 2" }
};

/**
 * Create an MCP server with capabilities for resources and tools
 * to manage N8N workflows
 */
const server = new Server(
  {
    name: "mcp-n8n-workflow",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

function writeErrorToFile(msg: string) {
  const errorFile = path.join(process.cwd(), 'error.log');
  fs.appendFileSync(errorFile, `${new Date().toISOString()} - ${msg}\n`);
}

/**
 * Helper functions for N8N API interactions
 */
async function fetchWithAuth(endpoint: string, options: RequestInit = {}) {
  let host_url = N8N_HOST;
  if (!host_url.includes('/api/v1')) {
    host_url += '/api/v1';
  }

  if (!host_url.endsWith('/')) {
    host_url += '/';
  }

  if (endpoint.startsWith('/')) {
    endpoint = endpoint.slice(1);
  }

  const url = `${host_url}${endpoint}`;
  if (!N8N_API_KEY) {
    throw new Error('N8N_API_KEY is required');
  }

  writeErrorToFile("doing request to: " + url);

  const headers = new Headers({
    'X-N8N-API-KEY': N8N_API_KEY,
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  });

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    writeErrorToFile("N8N API error: " + response.statusText);
    throw new Error(`N8N API error: ${response.statusText}`);
  }

  return response.json();
}

async function listWorkflows(): Promise<N8NWorkflow[]> {
  return fetchWithAuth('/workflows');
}

async function getWorkflow(id: string): Promise<N8NWorkflow> {
  return fetchWithAuth(`/workflows/${id}`);
}

async function createWorkflow(data: { name: string; nodes: any[]; connections: any }): Promise<N8NWorkflow> {
  return fetchWithAuth('/workflows', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

async function updateWorkflow(id: string, data: Partial<N8NWorkflow>): Promise<N8NWorkflow> {
  return fetchWithAuth(`/workflows/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

async function getWorkflowExecutions(id: string, params?: {
  includeData?: boolean;
  status?: 'error' | 'success' | 'waiting';
  limit?: number;
  cursor?: string;
}): Promise<N8NWorkflowExecution[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('workflowId', id);

  if (params?.includeData !== undefined) searchParams.set('includeData', String(params.includeData));
  if (params?.status) searchParams.set('status', params.status);
  if (params?.limit) searchParams.set('limit', String(Math.min(params.limit, 25)));
  if (params?.cursor) searchParams.set('cursor', params.cursor);

  const queryString = searchParams.toString();
  return fetchWithAuth(`/executions${queryString ? '?' + queryString : ''}`);
}

async function activateWorkflow(id: string, active: boolean): Promise<N8NWorkflow> {
  return fetchWithAuth(`/workflows/${id}/${active ? 'activate' : 'deactivate'}`, {
    method: 'POST',
  });
}

/**
 * Handler for listing available notes as resources.
 * Each note is exposed as a resource with:
 * - A note:// URI scheme
 * - Plain text MIME type
 * - Human readable name and description (now including the note title)
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: Object.entries(notes).map(([id, note]) => ({
      uri: `note:///${id}`,
      mimeType: "text/plain",
      name: note.title,
      description: `A text note: ${note.title}`
    }))
  };
});

/**
 * Handler for reading the contents of a specific note.
 * Takes a note:// URI and returns the note content as plain text.
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const url = new URL(request.params.uri);
  const id = url.pathname.replace(/^\//, '');
  const note = notes[id];

  if (!note) {
    throw new Error(`Note ${id} not found`);
  }

  return {
    contents: [{
      uri: request.params.uri,
      mimeType: "text/plain",
      text: note.content
    }]
  };
});

/**
 * Handler that lists available tools for N8N workflow management.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_workflows",
        description: "List all N8N workflows",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "get_workflow",
        description: "Get a specific N8N workflow by ID",
        inputSchema: {
          type: "object",
          properties: {
            workflowId: {
              type: "string",
              description: "ID of the workflow to fetch"
            }
          },
          required: ["workflowId"]
        }
      },
      {
        name: "create_workflow",
        description: "Create a new N8N workflow",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name of the workflow"
            },
            nodes: {
              type: "array",
              description: "Array of workflow nodes",
              items: {
                type: "object"
              }
            },
            connections: {
              type: "object",
              description: "Workflow connections configuration"
            }
          },
          required: ["name", "nodes", "connections"]
        }
      },
      {
        name: "update_workflow",
        description: "Update an existing N8N workflow",
        inputSchema: {
          type: "object",
          properties: {
            workflowId: {
              type: "string",
              description: "ID of the workflow to update"
            },
            name: {
              type: "string",
              description: "New name of the workflow"
            },
            nodes: {
              type: "array",
              description: "Updated array of workflow nodes",
              items: {
                type: "object"
              }
            },
            connections: {
              type: "object",
              description: "Updated workflow connections configuration"
            }
          },
          required: ["workflowId"]
        }
      },
      {
        name: "get_workflow_executions",
        description: "Get the execution history of a workflow",
        inputSchema: {
          type: "object",
          properties: {
            workflowId: {
              type: "string",
              description: "ID of the workflow"
            },
            includeData: {
              type: "boolean",
              description: "Whether to include the execution's detailed data"
            },
            status: {
              type: "string",
              enum: ["error", "success", "waiting"],
              description: "Status to filter the executions by"
            },
            limit: {
              type: "number",
              maximum: 250,
              description: "Maximum number of executions to return (max: 250)"
            },
            cursor: {
              type: "string",
              description: "Cursor for pagination"
            }
          },
          required: ["workflowId"]
        }
      },
      {
        name: "activate_workflow",
        description: "Activate or deactivate a workflow",
        inputSchema: {
          type: "object",
          properties: {
            workflowId: {
              type: "string",
              description: "ID of the workflow"
            },
            active: {
              type: "boolean",
              description: "Whether to activate (true) or deactivate (false) the workflow"
            }
          },
          required: ["workflowId", "active"]
        }
      }
    ]
  };
});

/**
 * Handler for all N8N workflow tools
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "list_workflows": {
      const workflows = await listWorkflows();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(workflows, null, 2)
        }]
      };
    }

    case "get_workflow": {
      const workflowId = String(request.params.arguments?.workflowId);
      if (!workflowId) {
        throw new Error("Workflow ID is required");
      }

      const workflow = await getWorkflow(workflowId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(workflow, null, 2)
        }]
      };
    }

    case "create_workflow": {
      const args = request.params.arguments as { name: string; nodes: any[]; connections: any } | undefined;
      if (!args?.name || !args?.nodes || !args?.connections) {
        throw new Error("Name, nodes, and connections are required");
      }

      const workflow = await createWorkflow(args);
      return {
        content: [{
          type: "text",
          text: `Created workflow ${workflow.id}: ${workflow.name}`
        }]
      };
    }

    case "update_workflow": {
      const workflowId = String(request.params.arguments?.workflowId);
      if (!workflowId) {
        throw new Error("Workflow ID is required");
      }

      const updateData = { ...(request.params.arguments as object) };
      delete (updateData as any).workflowId;

      const workflow = await updateWorkflow(workflowId, updateData);
      return {
        content: [{
          type: "text",
          text: `Updated workflow ${workflow.id}: ${workflow.name}`
        }]
      };
    }

    case "get_workflow_executions": {
      const workflowId = String(request.params.arguments?.workflowId);
      if (!workflowId) {
        throw new Error("Workflow ID is required");
      }

      const executions = await getWorkflowExecutions(workflowId, {
        includeData: request.params.arguments?.includeData as boolean | undefined,
        status: request.params.arguments?.status as 'error' | 'success' | 'waiting' | undefined,
        limit: request.params.arguments?.limit as number | undefined,
        cursor: request.params.arguments?.cursor as string | undefined
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(executions, null, 2)
        }]
      };
    }

    case "activate_workflow": {
      const workflowId = String(request.params.arguments?.workflowId);
      const active = Boolean(request.params.arguments?.active);
      if (!workflowId) {
        throw new Error("Workflow ID is required");
      }

      const workflow = await activateWorkflow(workflowId, active);
      return {
        content: [{
          type: "text",
          text: `Workflow ${workflow.id} ${active ? 'activated' : 'deactivated'}`
        }]
      };
    }

    default:
      throw new Error("Unknown tool");
  }
});

/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
