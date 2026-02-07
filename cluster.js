/**
 * Cluster Mode for Multi-Core CPU Utilization
 * Enables the application to handle higher RPS by utilizing all CPU cores
 */

import cluster from 'cluster';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

const numCPUs = os.cpus().length;
const CLUSTER_MODE = process.env.CLUSTER_MODE === 'true';

if (CLUSTER_MODE && cluster.isPrimary) {
    console.log(`🚀 Primary ${process.pid} is running`);
    console.log(`🔧 Starting ${numCPUs} workers...`);

    // Fork workers for each CPU core
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    // Handle worker exit
    cluster.on('exit', (worker, code, signal) => {
        console.log(`⚠️ Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
        cluster.fork();
    });

    // Handle worker online
    cluster.on('online', (worker) => {
        console.log(`✅ Worker ${worker.process.pid} is online`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
        console.log('🛑 SIGTERM received, shutting down workers...');
        for (const id in cluster.workers) {
            cluster.workers[id].kill('SIGTERM');
        }
    });

    process.on('SIGINT', () => {
        console.log('🛑 SIGINT received, shutting down workers...');
        for (const id in cluster.workers) {
            cluster.workers[id].kill('SIGINT');
        }
        process.exit(0);
    });
} else {
    // Worker process - start the server
    import('./server.js');
}
