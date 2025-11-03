const handleError = ((res, error, status) => {
    console.log(error)
    res.status(status ? status : 500).send(error)
})

const handleResponse = ((res, message, data) =>
    res.status(200).json({
        message: message ? message : '',
        data: data ? data : {}
    })
)

module.exports = {
    handleError,
    handleResponse
}