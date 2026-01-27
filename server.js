const express = require("express");
const path = require("path");
const axios = require("axios");


const app = express();
const PORT = 3000 || 4000 || 5000;
const MY_RENDER_URL = "https://mako-trade-bot.onrender.com/ping";

const connectDB = require("./database/db.js");
const auth = require("./src/routers/auth.routes.js")

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.json());

connectDB();

app.use("/auth",auth)

app.get('/ping',(req,res)=>{
  res.json({ping:"pong"})
})

app.get("/",(req,res)=>{
  res.status(200).json({message:"https://x.com/tradewithmako"})
})
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

setInterval(() => {
    axios.get(MY_RENDER_URL)
        .then(() => console.log("⏰ Keep-alive ping sent."))
        .catch((err) => console.error("⚠️ Keep-alive ping failed:", err.message));
}, 45000);

