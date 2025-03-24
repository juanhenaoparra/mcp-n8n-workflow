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

interface N8NCredential {
  id: string;
  name: string;
  type: string;
  data: Record<string, any>;
}

interface N8NCredentialSchema {
  additionalProperties: boolean;
  type: string;
  properties: Record<string, any>;
  required: string[];
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

enum LogSeverity {
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR'
}

interface LogPayload {
  [key: string]: any;
}

function log(name: string, severity: LogSeverity, payload: LogPayload) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    name,
    severity,
    ...payload
  };

  switch (severity) {
    case LogSeverity.ERROR:
      console.error(JSON.stringify(logEntry));
      break;
    case LogSeverity.WARN:
      console.warn(JSON.stringify(logEntry));
      break;
    case LogSeverity.INFO:
      console.info(JSON.stringify(logEntry));
      break;
  }
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

  log('do_n8n_api_request', LogSeverity.INFO, {
    url,
    method: options.method || 'GET'
  });

  const headers = new Headers({
    'X-N8N-API-KEY': N8N_API_KEY,
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  });

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    log('do_n8n_api_request_failed', LogSeverity.ERROR, {
      url,
      method: options.method || 'GET',
      status: response.status,
      statusText: response.statusText
    });

    throw new Error(`N8N API error: ${response.statusText}`);
  }

  return response.json();
}

async function listWorkflows(params?: { active?: boolean, tags?: string, limit?: number, cursor?: string }): Promise<N8NWorkflow[]> {
  const searchParams = new URLSearchParams();
  if (params?.active !== undefined) searchParams.set('active', String(params.active));
  if (params?.tags) searchParams.set('tags', params.tags);
  if (params?.limit) searchParams.set('limit', String(Math.min(params.limit, 25)));
  if (params?.cursor) searchParams.set('cursor', params.cursor);

  return fetchWithAuth('/workflows' + (searchParams.toString() ? '?' + searchParams.toString() : ''));
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

async function createCredential(data: { name: string; type: string; data: Record<string, any> }): Promise<N8NCredential> {
  return fetchWithAuth('/credentials', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

async function getCredentialSchema(type: string): Promise<N8NCredentialSchema> {
  return fetchWithAuth(`/credentials/schema/${type}`);
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
          properties: {
            "active": {
              type: "boolean",
              description: "Whether to filter by active workflows"
            },
            "tags": {
              type: "string",
              description: "Tags to filter by. Comma separated list of tags"
            },
            "limit": {
              type: "number",
              maximum: 250,
              description: "Maximum number of workflows to return"
            },
            "cursor": {
              type: "string",
              description: "Cursor for pagination"
            }
          },
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
      },
      {
        name: "create_credential",
        description: "Create a new credential",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name of the credential"
            },
            type: {
              type: "string",
              description: "Type of the credential (e.g., 'githubApi')"
            },
            data: {
              type: "object",
              description: "Credential data object containing the required fields"
            }
          },
          required: ["name", "type", "data"]
        }
      },
      {
        name: "get_credential_schema",
        description: "Get the required schema for a specific credential type",
        inputSchema: {
          type: "object",
          properties: {
            credentialTypeName: {
              type: "string",
              description: "Name of the credential type to get the schema for"
            }
          },
          required: ["credentialTypeName"]
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
      const args = request.params.arguments as { active?: boolean, tags?: string, limit?: number, cursor?: string } | undefined;

      const workflows = await listWorkflows(args);
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

    case "create_credential": {
      const args = request.params.arguments as { name: string; type: string; data: Record<string, any> } | undefined;
      if (!args?.name || !args?.type || !args?.data) {
        throw new Error("Name, type, and data are required");
      }

      const credential = await createCredential(args);
      return {
        content: [{
          type: "text",
          text: `Created credential ${credential.id}: ${credential.name} (${credential.type})`
        }]
      };
    }

    case "get_credential_schema": {
      const credentialTypeName = String(request.params.arguments?.credentialTypeName);
      if (!credentialTypeName) {
        throw new Error("Credential type name is required");
      }

      const schema = await getCredentialSchema(credentialTypeName);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(schema, null, 2)
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
