## SavePoint Overview

This tool allows players to create and store notes taken during their gameplay sessions. You can see a short (and somewhat out of date) demo [here](https://www.youtube.com/watch?v=LIdFdVaLWCI&list=PLI1UA0q3OsunU0jM1oe7fMegbA5Yc4uJD). This is a great tool for researchers who study games and player experience, game developers in playtesting phases of development, or for everyday players who might just want to annotate their gameplay. 

## Getting Started

[NOTE: If you know Nisha personally, you can skip all of the following steps and send her an email asking for a build. This will save you a lot of work.]

To get the tool running locally, follow these steps:

1. **Clone the repository**
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Start the application:**
   ```bash
   npm run start
   ```

---

## Configuration

The application requires specific environment variables to interact with AWS. Because the `.env` file is excluded from the repository for security, you must create one manually in the root directory.

### `.env` Template
Create a file named `.env` and populate it with your credentials:

```env
AWS_ACCESS_KEY_ID=[enter your own]
AWS_SECRET_ACCESS_KEY=[enter your own]
AWS_REGION=us-west-2
AWS_BUCKET_NAME=game-annotator
AWS_ROLE_ARN=arn:aws:iam::378382627972:role/gameannotator
```

---

## AWS IAM Setup

To successfully authenticate, you will need to create an **IAM User** and an **IAM Role** with the following configurations.

### 1. Role Policy
Attach this policy to your role to allow the application to list and manage objects in the S3 bucket.

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AllowListBucket",
            "Effect": "Allow",
            "Action": [
                "s3:ListBucket"
            ],
            "Resource": "arn:aws:s3:::game-annotator"
        },
        {
            "Sid": "AllowBucketObjects",
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject"
            ],
            "Resource": "arn:aws:s3:::game-annotator/*"
        }
    ]
}
```

### 2. Trust Relationship
The role must trust your IAM user to allow the `sts:AssumeRole` action. Update the Principal ARN below to match your specific IAM user.

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "AWS": "arn:aws:iam::378382627972:user/gameannotator-user"
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
```
