module.exports = {
    apps: [{
        name: "myapp-api",
        script: "./server.js", // или dist/server.js
        instances: "max",
        exec_mode: "cluster",
        env: {
            NODE_ENV: "production",
            PORT: 3000
        },
        watch: false,
        max_memory_restart: "512M",
        out_file: "~/.pm2/logs/myapp-api-out.log",
        error_file: "~/.pm2/logs/myapp-api-err.log"
    }]
}