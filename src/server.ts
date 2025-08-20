import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    CallToolResult,
    McpError,
    ErrorCode,
    Tool,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosError, Method } from 'axios';
import express from "express";
import { Request, Response, NextFunction } from 'express';
import * as console from 'console';
import { tools } from './tools.js';

const app = express();

// Environment variables are loaded by the main index.ts
const API_BASE_URL = process.env.API_BASE_URL || 'https://api.ahrefs.com/v3';
const API_KEY = process.env.API_KEY;
const axiosInstance = axios.create({
    baseURL: API_BASE_URL, // Axios will use this as the base for requests
    timeout: 30000, // 30 second timeout
});

function mapApiErrorToMcpError(error: unknown): McpError {
    if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;
        // Attempt to get a meaningful message from response data or default Axios message
        const apiMessage = (axiosError.response?.data as any)?.error || (axiosError.response?.data as any)?.message || (axiosError.response?.data as any)?.detail || axiosError.message;

        console.error(`API Error: Status ${status}, Message: ${apiMessage}`, axiosError.response?.data);

        switch (status) {
            case 400: return new McpError(ErrorCode.InvalidParams, `API Bad Request: ${apiMessage}`);
            case 404: return new McpError(ErrorCode.MethodNotFound, `API Not Found: ${apiMessage}`);
            case 408: return new McpError(ErrorCode.RequestTimeout, `API Request Timeout: ${apiMessage}`);
            case 500: case 502: case 503: case 504:
                return new McpError(ErrorCode.InternalError, `API Server Error (${status}): ${apiMessage}`);
            default:
                return new McpError(ErrorCode.InternalError, `API Request Failed (${status}): ${apiMessage}`);
        }
    } else if (error instanceof Error) {
        console.error(`Request Error: ${error.message}`, error);
        return new McpError(ErrorCode.InternalError, `Request failed: ${error.message}`);
    } else {
        console.error('Unknown internal error occurred:', error);
        return new McpError(ErrorCode.InternalError, 'An unknown internal error occurred');
    }
}

process.on('SIGINT', async () => {
    console.error("Received SIGINT, shutting down server...");
    await server.close();
    console.error("Server closed.");
    process.exit(0);
});
process.on('SIGTERM', async () => {
    console.error("Received SIGTERM, shutting down server...");
    await server.close();
    console.error("Server closed.");
    process.exit(0);
});

const server = new Server(
  {
    name: "ahrefs-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
        tools: {},
    },
  },
);

let transport: SSEServerTransport | null = null;

app.get("/sse", (req: Request, res: Response) => {
  transport = new SSEServerTransport("/messages", res);
  server.connect(transport).then(() => {
        console.error("MCP server connected via SSE and running.");
        console.error("MCP_SERVER_READY");
    })
    .catch(error => {
        console.error("Failed to connect MCP server via SSE:", error);
        process.exit(1);
    });
});

app.post("/messages", (req: Request, res: Response) => {
  if (transport) {
    transport.handlePostMessage(req, res);
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error("Handling ListTools request");
    return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};
    console.error(`Received CallTool request for: ${toolName}`, args);

    if (toolName === "doc") {
        const requestedToolName = String(args.tool).split('_').pop();
        const requestedTool = tools.find(t => t.name === requestedToolName);
        if (!requestedTool) {
            console.error(`Tool not found: ${requestedToolName}`);
            throw new McpError(ErrorCode.MethodNotFound, `Tool '${requestedToolName}' not found.`);
        }
        return { content: [{ type: 'text', text: JSON.stringify(requestedTool._inputSchema, null, 2) }] };
    }

    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
        console.error(`Tool not found: ${toolName}`);
        throw new McpError(ErrorCode.MethodNotFound, `Tool '${toolName}' not found.`);
    }

    // Retrieve original OpenAPI details attached during generation
    const originalMethod = (tool as any)._original_method as Method; // Cast to Axios Method type
    const originalPath = (tool as any)._original_path as string;
    const originalParameters = (tool as any)._original_parameters as any[] || [];
    const originalRequestBodyInfo = (tool as any)._original_request_body as { required: boolean, content_type: string | null } | null;

    if (!originalMethod || !originalPath) {
        console.error(`Missing original operation details for tool: ${toolName}`);
        throw new McpError(ErrorCode.InternalError, `Internal configuration error for tool '${toolName}'.`);
    }

    try {
        let targetPath = originalPath;
        const queryParams: Record<string, any> = {};
        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'User-Agent': 'ahrefs-mcp-server'
        };
        let requestData: any = undefined;
        let requestBody: any = args.requestBody;
        headers["Authorization"] = `Bearer ${API_KEY}`;

        // Process parameters based on their 'in' location
        for (const param of originalParameters) {
            const paramName = param.name;
            const paramIn = param.in; // path, query, header
            let paramValue = args[paramName];

            // Lowercase specific parameters
            if (paramValue !== undefined && paramValue !== null && ["us_state", "country", "country_code"].includes(paramName)) {
                paramValue = String(paramValue).toLowerCase();
            }

            if (paramValue !== undefined && paramValue !== null) {
                if (paramIn === 'path') {
                    targetPath = targetPath.replace(`{${paramName}}`, encodeURIComponent(String(paramValue)));
                } else if (paramIn === 'query') {
                    queryParams[paramName] = paramValue;
                } else if (paramIn === 'header') {
                    headers[paramName] = String(paramValue);
                } else if (paramIn === 'body') {
                    if (!requestBody) {
                        requestBody = {};
                    }
                    requestBody[paramName] = paramValue;
                }
            } else if (param.required) {
                console.error(`Missing required parameter '${paramName}' for tool ${toolName}`);
                throw new McpError(ErrorCode.InvalidParams, `Missing required parameter: ${paramName}`);
            }
        }

        // Process requestBody
        if (originalRequestBodyInfo && requestBody !== undefined && requestBody !== null) {
            requestData = requestBody;
            headers['Content-Type'] = originalRequestBodyInfo.content_type || 'application/json';
        } else if (originalRequestBodyInfo?.required) {
            console.error(`Missing required requestBody for tool ${toolName}`);
            throw new McpError(ErrorCode.InvalidParams, `Missing required requestBody`);
        } else if (requestData !== undefined) {
            headers['Content-Type'] = 'application/json';
        }

        // Make API Call - Axios combines baseURL and url
        const requestUrl = targetPath; // Use the path directly
        console.error(`Making API call: ${originalMethod} ${axiosInstance.defaults.baseURL}${requestUrl}`);
        const response = await axiosInstance.request({
            method: originalMethod,
            url: requestUrl, // Use the relative path; Axios combines it with baseURL
            params: queryParams,
            headers: headers,
            data: requestData,
            validateStatus: (status: number) => status >= 200 && status < 300, // Only 2xx are considered success
        });

        console.error(`API call successful for ${toolName}, Status: ${response.status}`);

        // Format Response for MCP
        let responseText: string;
        const responseContentType = response.headers['content-type'];
        if (responseContentType && responseContentType.includes('application/json') && typeof response.data === 'object') {
            try {
                responseText = JSON.stringify(response.data, null, 2); // Pretty-print JSON
            } catch (e) {
                console.error("Failed to stringify JSON response, returning as string.", e);
                responseText = String(response.data);
            }
        } else {
            responseText = String(response.data); // Return non-JSON as plain text
        }

        return { content: [{ type: 'text', text: responseText }] };

    } catch (error) {
        console.error(`Error during API call for tool ${toolName}:`, error);
        const mcpError = mapApiErrorToMcpError(error);
        return {
            content: [{ type: 'text', text: mcpError.message }],
            isError: true,
            error: mcpError, // Include structured error
        };
    }
});

app.listen(3000);