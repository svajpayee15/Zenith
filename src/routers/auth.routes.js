const express = require("express")
const router = express.Router()

const { approveGet, approvePost } = require("../controllers/approve.controller.js")
const { revokeGet, revokePost } = require("../controllers/revoke.controller.js")
const { bind, revoke } = require("../controllers/agent.controller.js")

router.get("/approve",approveGet)
router.get("/revoke",revokeGet)

router.post("/verify/approve",approvePost)
router.post("/verify/revoke",revokePost)

router.post("/agent/bind",bind)
router.post("/agent/revoke",revoke)


module.exports = router

