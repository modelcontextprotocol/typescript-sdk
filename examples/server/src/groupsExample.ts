// Run with:
//   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/groupsExample.ts

import type { CallToolResult, GetPromptResult, ReadResourceResult } from '@modelcontextprotocol/server';
import { GROUPS_META_KEY, McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const server = new McpServer({
    name: 'groups-example-server',
    version: '1.0.0'
});

/**
 * Helper to attach a single group membership to a primitive.
 *
 * The groups proposal stores membership in `_meta[GROUPS_META_KEY]`.
 * This same mechanism is used for:
 * - tools/resources/prompts belonging to a group
 * - child groups declaring which parent group(s) they are contained by
 */
function metaForGroup(groupName: string) {
    return {
        _meta: {
            [GROUPS_META_KEY]: [groupName]
        }
    };
}

// ---- Groups ------------------------------------------------------------------------------
// This example defines two parent groups (`work`, `communications`) and five child groups.
// Child groups declare containment by including the parent name in `_meta[GROUPS_META_KEY]`.

// Parent groups (no `_meta` needed; they are roots in this example)
server.registerGroup('work', {
    title: 'Work',
    description: 'Tools, resources, and prompts related to day-to-day work.'
});

server.registerGroup('communications', {
    title: 'Communications',
    description: 'Tools, resources, and prompts related to messaging and scheduling.'
});

// Child groups (each one is “contained by” a parent group)
server.registerGroup('spreadsheets', {
    title: 'Spreadsheets',
    description: 'Spreadsheet-like operations: create sheets, add rows, and do quick calculations.',
    _meta: {
        [GROUPS_META_KEY]: ['work']
    }
});

server.registerGroup('documents', {
    title: 'Documents',
    description: 'Document drafting, editing, and summarization workflows.',
    _meta: {
        [GROUPS_META_KEY]: ['work']
    }
});

server.registerGroup('todos', {
    title: 'Todos',
    description: 'Task capture and lightweight task management.',
    _meta: {
        [GROUPS_META_KEY]: ['work']
    }
});

server.registerGroup('email', {
    title: 'Email',
    description: 'Email composition and inbox-oriented operations.',
    _meta: {
        [GROUPS_META_KEY]: ['communications']
    }
});

server.registerGroup('calendar', {
    title: 'Calendar',
    description: 'Scheduling operations and event management.',
    _meta: {
        [GROUPS_META_KEY]: ['communications']
    }
});

// ---- Tools -------------------------------------------------------------------------------
// Tools are assigned to a group by including `_meta[GROUPS_META_KEY]`.
// In this example they are simple stubs that return a confirmation string.

// Email tools
server.registerTool(
    'email_send',
    {
        description: 'Send an email message.',
        inputSchema: {
            to: z.string().describe('Recipient email address'),
            subject: z.string().describe('Email subject'),
            body: z.string().describe('Email body')
        },
        ...metaForGroup('email')
    },
    async ({ to, subject }): Promise<CallToolResult> => {
        return { content: [{ type: 'text', text: `Sent email to ${to} with subject "${subject}".` }] };
    }
);

server.registerTool(
    'email_search_inbox',
    {
        description: 'Search the inbox by query string.',
        inputSchema: {
            query: z.string().describe('Search query')
        },
        ...metaForGroup('email')
    },
    async ({ query }): Promise<CallToolResult> => {
        return { content: [{ type: 'text', text: `Searched inbox for "${query}".` }] };
    }
);

// Calendar tools
server.registerTool(
    'calendar_create_event',
    {
        description: 'Create a calendar event.',
        inputSchema: {
            title: z.string().describe('Event title'),
            when: z.string().describe('When the event occurs (free-form, e.g. "tomorrow 2pm")')
        },
        ...metaForGroup('calendar')
    },
    async ({ title, when }): Promise<CallToolResult> => {
        return { content: [{ type: 'text', text: `Created calendar event "${title}" at ${when}.` }] };
    }
);

server.registerTool(
    'calendar_list_upcoming',
    {
        description: 'List upcoming calendar events (demo).',
        inputSchema: {
            days: z.number().describe('Number of days ahead to look').default(7)
        },
        ...metaForGroup('calendar')
    },
    async ({ days }): Promise<CallToolResult> => {
        return { content: [{ type: 'text', text: `Listed upcoming calendar events for the next ${days} day(s).` }] };
    }
);

// Spreadsheets tools
server.registerTool(
    'spreadsheets_create',
    {
        description: 'Create a new spreadsheet.',
        inputSchema: {
            name: z.string().describe('Spreadsheet name')
        },
        ...metaForGroup('spreadsheets')
    },
    async ({ name }): Promise<CallToolResult> => {
        return { content: [{ type: 'text', text: `Created spreadsheet "${name}".` }] };
    }
);

server.registerTool(
    'spreadsheets_add_row',
    {
        description: 'Add a row to a spreadsheet.',
        inputSchema: {
            spreadsheet: z.string().describe('Spreadsheet name'),
            values: z.array(z.string()).describe('Row values')
        },
        ...metaForGroup('spreadsheets')
    },
    async ({ spreadsheet, values }): Promise<CallToolResult> => {
        return {
            content: [{ type: 'text', text: `Added row to "${spreadsheet}": [${values.join(', ')}].` }]
        };
    }
);

// Documents tools
server.registerTool(
    'documents_create',
    {
        description: 'Create a document draft.',
        inputSchema: {
            title: z.string().describe('Document title')
        },
        ...metaForGroup('documents')
    },
    async ({ title }): Promise<CallToolResult> => {
        return { content: [{ type: 'text', text: `Created document "${title}".` }] };
    }
);

server.registerTool(
    'documents_summarize',
    {
        description: 'Summarize a document (demo).',
        inputSchema: {
            title: z.string().describe('Document title')
        },
        ...metaForGroup('documents')
    },
    async ({ title }): Promise<CallToolResult> => {
        return { content: [{ type: 'text', text: `Summarized document "${title}".` }] };
    }
);

// Todos tools
server.registerTool(
    'todos_add',
    {
        description: 'Add a todo item.',
        inputSchema: {
            text: z.string().describe('Todo text')
        },
        ...metaForGroup('todos')
    },
    async ({ text }): Promise<CallToolResult> => {
        return { content: [{ type: 'text', text: `Added todo: "${text}".` }] };
    }
);

server.registerTool(
    'todos_complete',
    {
        description: 'Mark a todo item complete.',
        inputSchema: {
            id: z.string().describe('Todo id')
        },
        ...metaForGroup('todos')
    },
    async ({ id }): Promise<CallToolResult> => {
        return { content: [{ type: 'text', text: `Completed todo with id ${id}.` }] };
    }
);

// ===== Resources =====

server.registerResource(
    'calendar_overview',
    'groups://calendar/overview',
    {
        mimeType: 'text/plain',
        description: 'A short overview of calendar-related concepts and workflows.',
        ...metaForGroup('calendar')
    },
    async (): Promise<ReadResourceResult> => {
        return {
            contents: [
                {
                    uri: 'groups://calendar/overview',
                    text:
                        'Calendars help coordinate time. Common workflows include creating events, inviting attendees, setting reminders, and reviewing upcoming commitments.\n\n' +
                        'Good scheduling habits include adding agendas, assigning owners, and keeping event titles descriptive so they are searchable.'
                }
            ]
        };
    }
);

server.registerResource(
    'email_overview',
    'groups://email/overview',
    {
        mimeType: 'text/plain',
        description: 'A short overview of email etiquette and structure.',
        ...metaForGroup('email')
    },
    async (): Promise<ReadResourceResult> => {
        return {
            contents: [
                {
                    uri: 'groups://email/overview',
                    text:
                        'Email is best for asynchronous communication with a clear subject, concise context, and a specific call to action.\n\n' +
                        'Strong emails include a brief greeting, the purpose in the first paragraph, and any needed links or bullet points.'
                }
            ]
        };
    }
);

server.registerResource(
    'spreadsheets_overview',
    'groups://spreadsheets/overview',
    {
        mimeType: 'text/plain',
        description: 'A short overview of spreadsheet structure and best practices.',
        ...metaForGroup('spreadsheets')
    },
    async (): Promise<ReadResourceResult> => {
        return {
            contents: [
                {
                    uri: 'groups://spreadsheets/overview',
                    text:
                        'Spreadsheets organize data into rows and columns. Use consistent headers, keep one concept per column, and avoid mixing units in a single column.\n\n' +
                        'For collaboration, document assumptions and prefer formulas over manual calculations.'
                }
            ]
        };
    }
);

server.registerResource(
    'documents_overview',
    'groups://documents/overview',
    {
        mimeType: 'text/plain',
        description: 'A short overview of document workflows.',
        ...metaForGroup('documents')
    },
    async (): Promise<ReadResourceResult> => {
        return {
            contents: [
                {
                    uri: 'groups://documents/overview',
                    text:
                        'Documents capture long-form thinking. Common workflows include drafting, reviewing, suggesting edits, and summarizing key decisions.\n\n' +
                        'Keep sections scannable with headings, and ensure decisions and next steps are easy to find.'
                }
            ]
        };
    }
);

server.registerResource(
    'todos_overview',
    'groups://todos/overview',
    {
        mimeType: 'text/plain',
        description: 'A short overview of task management basics.',
        ...metaForGroup('todos')
    },
    async (): Promise<ReadResourceResult> => {
        return {
            contents: [
                {
                    uri: 'groups://todos/overview',
                    text:
                        'Todo lists help track commitments. Capture tasks as verbs, keep them small, and regularly review to prevent backlog buildup.\n\n' +
                        'If a task takes multiple steps, split it into subtasks or link it to a more detailed plan.'
                }
            ]
        };
    }
);

// ===== Prompts =====

server.registerPrompt(
    'email_thank_contributor',
    {
        description: 'Compose an email thanking someone for their recent contributions.',
        argsSchema: {
            name: z.string().describe('Recipient name')
        },
        ...metaForGroup('email')
    },
    async ({ name }): Promise<GetPromptResult> => {
        return {
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Compose an email thanking ${name} for their recent contributions. Keep it warm, specific, and concise.`
                    }
                }
            ]
        };
    }
);

server.registerPrompt(
    'calendar_meeting_agenda',
    {
        description: 'Draft a short agenda for an upcoming meeting.',
        argsSchema: {
            topic: z.string().describe('Meeting topic')
        },
        ...metaForGroup('calendar')
    },
    async ({ topic }): Promise<GetPromptResult> => {
        return {
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Draft a short meeting agenda for a meeting about: ${topic}. Include goals, timeboxes, and expected outcomes.`
                    }
                }
            ]
        };
    }
);

server.registerPrompt(
    'spreadsheets_quick_analysis',
    {
        description: 'Suggest a simple spreadsheet layout for tracking a metric.',
        argsSchema: {
            metric: z.string().describe('The metric to track')
        },
        ...metaForGroup('spreadsheets')
    },
    async ({ metric }): Promise<GetPromptResult> => {
        return {
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Suggest a simple spreadsheet layout for tracking: ${metric}. Include column headers and a brief note on how to use it.`
                    }
                }
            ]
        };
    }
);

server.registerPrompt(
    'documents_write_outline',
    {
        description: 'Create an outline for a document on a topic.',
        argsSchema: {
            topic: z.string().describe('Document topic')
        },
        ...metaForGroup('documents')
    },
    async ({ topic }): Promise<GetPromptResult> => {
        return {
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Create a clear outline for a document about: ${topic}. Use headings and a short description under each heading.`
                    }
                }
            ]
        };
    }
);

server.registerPrompt(
    'todos_plan_day',
    {
        description: 'Turn a list of tasks into a simple day plan.',
        argsSchema: {
            tasks: z.array(z.string()).describe('Tasks to plan')
        },
        ...metaForGroup('todos')
    },
    async ({ tasks }): Promise<GetPromptResult> => {
        return {
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Create a simple plan for the day from these tasks:\n- ${tasks.join('\n- ')}\n\nPrioritize and group similar tasks.`
                    }
                }
            ]
        };
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // IMPORTANT: In stdio mode, avoid writing to stdout (it is used for MCP messages).
    console.error('Groups example MCP server running on stdio.');
}

await main();
