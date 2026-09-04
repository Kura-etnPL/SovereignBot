import { app } from "electron";
import { runVerifyP35ThisPcDeepLinks } from "./verify-p35-this-pc-deep-links.js";

app.whenReady().then(() => runVerifyP35ThisPcDeepLinks({ app })).catch((error) => { console.error(error); app.exit(1); });
