const { z } = require("zod")

const marketOrderSchema = z.object({
    data: z.object({
        amount: z.number().min(),
        builder_code: z.literal("prathamdev69"),
        
    })
})