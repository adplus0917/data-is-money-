const S3rver = require("s3rver");
new S3rver({ port: 4568, address: "localhost", silent: true, directory: require("os").tmpdir() + "/dp-s3data" }).run().then(() => console.log("s3rver on 4568"));
