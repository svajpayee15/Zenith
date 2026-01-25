const { z } = require("zod");

const authApiSchemaGet = z.object({
  userId: z.string().min(15, "Invalid user id").max(20, "Invalid user id"),
  nonce: z.string().length(32, "Invalid nonce"),
});
const authApiSchemaPost = z.object({
  userId: z.string().min(15, "Invalid user id").max(20, "Invalid user id"),
  walletAddress: z
    .string()
    .min(32, "Invalid walletAddress")
    .max(44, "Invalid walletAddress"),
  signature: z.array(z.number()),
  payload: z.object({
    data: z.object({
      builder_code: z.literal("prathamdev69"),
      max_fee_rate: z.literal("0.001").optional(),
    }),
    expiry_window: z.literal(5000),
    timestamp: z.number(),
    type: z.enum(["approve_builder_code", "revoke_builder_code"]),
  }),
});

function vaasfG(userId, nonce) {
  // vaasfG : Validate Auth API Schema Function ( Get )
  const result = authApiSchemaGet.safeParse({ userId, nonce });
  return result;
}

function vaasfP(userId, walletAddress, signature, payload) {
  // vaasfP : Validate Auth API Schema Function ( Post )
  const result = authApiSchemaPost.safeParse({
    userId,
    walletAddress,
    signature,
    payload,
  });
  return result;
}

module.exports = { vaasfG, vaasfP };
