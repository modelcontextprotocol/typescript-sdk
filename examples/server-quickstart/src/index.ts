//#region prelude
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const NWS_API_BASE = 'https://api.weather.gov';
const USER_AGENT = 'weather-app/1.0';
//#endregion prelude

//#region helpers
// Helper function for making NWS API requests
async function makeNWSRequest<T>(url: string): Promise<T | null> {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/geo+json',
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error('Error making NWS request:', error);
    return null;
  }
}

interface AlertFeature {
  properties: {
    event?: string;
    areaDesc?: string;
    severity?: string;
    status?: string;
    headline?: string;
  };
}

// Format alert data
function formatAlert(feature: AlertFeature): string {
  const props = feature.properties;
  return [
    `Event: ${props.event || 'Unknown'}`,
    `Area: ${props.areaDesc || 'Unknown'}`,
    `Severity: ${props.severity || 'Unknown'}`,
    `Status: ${props.status || 'Unknown'}`,
    `Headline: ${props.headline || 'No headline'}`,
    '---',
  ].join('\n');
}

interface ForecastPeriod {
  name?: string;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
}

interface AlertsResponse {
  features: AlertFeature[];
}

interface PointsResponse {
  properties: {
    forecast?: string;
  };
}

interface ForecastResponse {
  properties: {
    periods: ForecastPeriod[];
  };
}
//#endregion helpers

//#region registerTools
// Create a server with both weather tools registered. The serving entry calls
// this factory to build the instance it serves, so keep it cheap and
// side-effect-free.
function createServer(): McpServer {
  const server = new McpServer({
    name: 'weather',
    version: '1.0.0',
  });

  server.registerTool(
    'get-alerts',
    {
      title: 'Get Weather Alerts',
      description: 'Get weather alerts for a state',
      inputSchema: z.object({
        state: z.string().length(2)
          .describe('Two-letter state code (e.g. CA, NY)'),
      }),
    },
    async ({ state }) => {
      const stateCode = state.toUpperCase();
      const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
      const alertsData = await makeNWSRequest<AlertsResponse>(alertsUrl);

      if (!alertsData) {
        return {
          content: [{
            type: 'text',
            text: 'Failed to retrieve alerts data',
          }],
          isError: true,
        };
      }

      const features = alertsData.features || [];

      if (features.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No active alerts for ${stateCode}`,
          }],
        };
      }

      const formattedAlerts = features.map(formatAlert);

      return {
        content: [{
          type: 'text',
          text: `Active alerts for ${stateCode}:\n\n${formattedAlerts.join('\n')}`,
        }],
      };
    },
  );

  server.registerTool(
    'get-forecast',
    {
      title: 'Get Weather Forecast',
      description: 'Get weather forecast for a location',
      inputSchema: z.object({
        latitude: z.number().min(-90).max(90)
          .describe('Latitude of the location'),
        longitude: z.number().min(-180).max(180)
          .describe('Longitude of the location'),
      }),
    },
    async ({ latitude, longitude }) => {
      // Get grid point data
      const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
      const pointsData = await makeNWSRequest<PointsResponse>(pointsUrl);

      if (!pointsData) {
        return {
          content: [{
            type: 'text',
            text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
          }],
          isError: true,
        };
      }

      const forecastUrl = pointsData.properties?.forecast;
      if (!forecastUrl) {
        return {
          content: [{
            type: 'text',
            text: 'Failed to get forecast URL from grid point data',
          }],
          isError: true,
        };
      }

      // Get forecast data
      const forecastData = await makeNWSRequest<ForecastResponse>(forecastUrl);
      if (!forecastData) {
        return {
          content: [{
            type: 'text',
            text: 'Failed to retrieve forecast data',
          }],
          isError: true,
        };
      }

      const periods = forecastData.properties?.periods || [];
      if (periods.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No forecast periods available',
          }],
        };
      }

      // Format forecast periods
      const formattedForecast = periods.map((period: ForecastPeriod) =>
        [
          `${period.name || 'Unknown'}:`,
          `Temperature: ${period.temperature || 'Unknown'}°${period.temperatureUnit || 'F'}`,
          `Wind: ${period.windSpeed || 'Unknown'} ${period.windDirection || ''}`,
          `${period.shortForecast || 'No forecast available'}`,
          '---',
        ].join('\n'),
      );

      return {
        content: [{
          type: 'text',
          text: `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join('\n')}`,
        }],
      };
    },
  );

  return server;
}
//#endregion registerTools

//#region main
void serveStdio(createServer);
console.error('Weather MCP Server running on stdio');
//#endregion main
