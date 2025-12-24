import * as path from "node:path";

import { Configuration } from "./Configuration.js";
import { Server } from "./Server.js";
export async function main(): Promise<void> {    
    const configPath = path.resolve(__dirname, 'servers.config.json');
    try {
        const serverConfigs = Configuration.loadConfig(configPath);

        const servers = Object.entries(serverConfigs.mcpServers).map(
            ([name, srvConfig]) => new Server(name, srvConfig)
        );
        console.log("Initializing servers...", servers); 
    }catch(e) {
        console.error('Error loading server configurations:', e);
        process.exit(1);
    }
     
 }

// Start the interactive client only when run directly
if (require.main === module) {
    main().catch(async (_error: unknown) => {
        process.exit(1);
    });
}
