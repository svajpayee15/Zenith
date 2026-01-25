const { z } = require("zod");

const authAgent = z.object({
    userId: z.string().min(15, "Invalid user id").max(20, "Invalid user id"),
    payload: z.object({
    account: z.string().min(32, "Invalid walletAddress").max(44, "Invalid walletAddress"),
    agent_wallet: z.literal("AF7dARxRpj1JgRJZdJMgPonKcJTkbZhL6GEA4jkZm5qo"),
    expiry_window: z.literal(5000),
    signature: z.array(z.number()),
    timestamp: z.number()
    })
})

function vpaaf(userId, payload){
    // vpaaf : Validate Pacifica Auth Agent Function
    const result = authAgent.safeParse({ userId, payload })
    return result;
}

module.exports = vpaaf;

