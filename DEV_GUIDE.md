# 🚀 Simple Dev Guide

## How to Run & Test

### **Step 1: Start the Dev Server**
```bash
pnpm dev
```

That's it! The server will:
- Start on **port 5050** (check your `.env` file)
- Auto-restart when you save changes in `src/`
- Show logs in the terminal

### **Step 2: Check if it's Running**
```bash
curl http://localhost:5050/
```

You should see:
```json
{
  "status": "ok",
  "service": "Twilio + OpenAI Realtime API Server",
  "version": "1.0.0",
  "activeSessions": 0
}
```

### **Step 3: Test Your Code**
- Make changes to files in `src/`
- Save the file
- Nodemon will **automatically restart** the server
- Your changes are **immediately live**

---

## Troubleshooting

### **Port Already in Use?**
If you see `EADDRINUSE: address already in use :::5050`:

```bash
# Kill any old processes
pnpm dev:clean

# Then start fresh
pnpm dev
```

### **Not Seeing Your Changes?**
1. Make sure you saved the file
2. Check terminal for: `[nodemon] restarting due to changes...`
3. If not, manually restart: `pnpm dev:start`

### **Check What Port You're Using**
```bash
# Check your .env file
cat .env | grep PORT
```

Default is **5050** unless you changed it.

---

## Quick Reference

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Start dev server (auto-restarts on changes) |
| `pnpm dev:start` | Clean restart (kills old processes first) |
| `pnpm dev:clean` | Kill any running dev processes |
| `pnpm build` | Build for production (not needed in dev) |
| `pnpm start` | Run production build (not for dev) |

---

## What Port to Use in Twilio?

**Use port 5050** (or whatever PORT is in your `.env` file)

If you're using ngrok:
```bash
ngrok http 5050
```

Then use the ngrok URL in your Twilio webhook configuration.

---

## Pro Tips

1. **Always use `pnpm dev`** - it auto-restarts when you save files
2. **Watch the terminal** - you'll see logs and any errors
3. **Check port 5050** - that's where your server runs
4. **Don't worry about `build`** - only needed for production deployment

