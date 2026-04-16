const express = require("express");
const path = require("path");
const axios = require("axios");
const helmet = require("helmet")
const rateLimit = require("express-rate-limit");
const cors = require("cors")

const app = express();
const PORT = 3000 || 4000 || 5000;
const MY_RENDER_URL = "https://zenith-e0xa.onrender.com//ping";

const connectDB = require("./database/db.js");
const auth = require("./src/routers/auth.routes.js")

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1);

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, 
  max: 50,
  standardHeaders: true, 
  legacyHeaders: false, 
  message: {
    success: false, 
    error: "Too many requests. Please cool down for a minute"
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(limiter);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.tailwindcss.com",
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com"
        ],
        fontSrc: [
          "'self'",
          "https://fonts.gstatic.com"
        ],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      }
    }
  })
);

 

connectDB();

app.use("/auth",auth)
app.use(cors())

app.get('/ping',(req,res)=>{
  res.json({ping:"pong"})
})

app.get("/",(req,res)=>{
 res.sendFile(path.join(__dirname, "public", "static", "index.html"));
})
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

setInterval(() => {
    axios.get(MY_RENDER_URL)
        .then(() => console.log("⏰ Keep-alive ping sent."))
        .catch((err) => console.error("⚠️ Keep-alive ping failed:", err.message));
}, 45000);

