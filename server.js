const express = require("express");
const path = require("path");


const app = express();
const PORT = 3000;

const connectDB = require("./database/db.js");
const auth = require("./src/routers/auth.routes.js")

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.json());

connectDB();

app.use("/auth",auth)

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});