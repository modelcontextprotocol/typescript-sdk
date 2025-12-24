import { Configuration } from "./Configuration.js";
import {Server} from "./Server.js"
import * as path from "node:path";
export async function main(): Promise<void> {    
    const configPath = path.resolve(__dirname, 'servers.config.json');
    try {
        const serverConfigs = Configuration.loadConfig(configPath);

        const servers = Object.entries(serverConfigs.mcpServers).map(
            ([name, srvConfig]) => new Server(name, srvConfig)
        ); 
    }catch(e) {
        console.error('Error loading server configurations:', e);
        process.exit(1);
    }
     
 }

// Start the interactive client only when run directly
if (require.main === module) {
    main().catch(async (error: unknown) => {
        process.exit(1);
    });
}
