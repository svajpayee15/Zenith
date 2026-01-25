function sortKeyRecursively(obj){
    if(Array.isArray(obj)){
        return obj.map(sortKeyRecursively)
    }
    else if(obj !== null && typeof obj === "object"){
        const sortedObj = {}
        Object.keys(obj)
            .sort()
            .forEach((key)=>{
                sortedObj[key] = sortKeyRecursively(obj[key])
            })

        return sortedObj
    }

    return obj
}

function preparePayloadforSigning(payload) {
    const sorted = sortKeyRecursively(payload)
    return JSON.stringify(sorted)
}

module.exports = preparePayloadforSigning