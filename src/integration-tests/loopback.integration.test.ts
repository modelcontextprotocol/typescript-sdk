import {JSONRPCRequest, ResultSchema} from "../types.js";
import {z} from "zod";
import {Server} from "../server/index.js";
import {Client} from "../client/index.js";
import {LoopbackTransport} from "../shared/loopback.js";

// Assume you have a base RequestSchema defined somewhere in your code.
// For this example, we create a minimal stub.
const RequestSchema = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.number(), z.string()]),
});

// Define the weather request schema.
const GetWeatherRequestSchema = RequestSchema.extend({
    method: z.literal("weather/get"),
    params: z.object({
        city: z.string(),
    }),
});
const WeatherResultSchema = ResultSchema.extend({
    temperature: z.number(),
    conditions: z.string(),
});

describe("Client-Server Integration Test for Weather Request", () => {
    let clientTransport: LoopbackTransport;
    let serverTransport: LoopbackTransport
    let client: Client;
    let server: Server;

    beforeEach(async () => {
        clientTransport = new LoopbackTransport();
        serverTransport = new LoopbackTransport();
        clientTransport.connect(serverTransport)

        server = new Server(
            {name: "test server", version: "1.0"},
            {
                capabilities: {
                    prompts: {},
                    resources: {},
                    tools: {},
                    logging: {},
                },
                instructions: "Test instructions",
            }
        );
        await server.connect(serverTransport);

        client = new Client(
            {name: "test client", version: "1.0"},
            {capabilities: {sampling: {}}}
        );

        await client.connect(clientTransport);

        // Register the weather request handler on the server.
        server.setRequestHandler(GetWeatherRequestSchema, (_) => {
            // In a real handler, you might use request.params.city.
            return {
                temperature: 72,
                conditions: "sunny",
            };
        });
    });

    test("client sends weather/get request and receives expected response", async () => {
        // Construct a JSONRPCRequest matching the weather schema.
        const request: JSONRPCRequest = {
            jsonrpc: "2.0",
            id: 1,
            method: "weather/get",
            params: {city: "New York"},
        };

        // The client issues the request; we assume client.request returns a promise resolving to a JSONRPCResponse.
        const response = await client.request(request, WeatherResultSchema);

        // Verify that the response from the server matches the expected result.
        expect(response).toEqual({temperature: 72, conditions: "sunny"});
    });

    test("server returns error response for invalid request", async () => {
        server.setRequestHandler(GetWeatherRequestSchema, () => {
            throw new Error("Unexpected server error");
        });

        const request: JSONRPCRequest = {
            jsonrpc: "2.0",
            id: 2,
            method: "weather/get",
            params: {city: "Invalid City"},
        };

        await expect(client.request(request, WeatherResultSchema)).rejects.toThrow();
    });

    test("multiple concurrent requests are handled correctly", async () => {
        const cities = ["New York", "London", "Tokyo"];
        server.setRequestHandler(GetWeatherRequestSchema, (req) => ({
            temperature: 20,
            conditions: `Weather for ${req.params.city}`,
        }));

        const responses = await Promise.all(
            cities.map((city, idx) => {
                const request: JSONRPCRequest = {
                    jsonrpc: "2.0",
                    id: idx + 1,
                    method: "weather/get",
                    params: {city},
                };
                return client.request(request, WeatherResultSchema);
            })
        );

        responses.forEach((response, idx) => {
            expect(response).toEqual({temperature: 20, conditions: `Weather for ${cities[idx]}`});
        });
    });

});
