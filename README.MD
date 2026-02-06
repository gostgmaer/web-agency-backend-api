# Web Development Agency API

A comprehensive REST API backend service for a Web Development Agency website, built with Node.js, Express.js, and MongoDB. This API serves both public marketing frontend and secured admin dashboard applications.

## 🚀 Features

- **JWT Authentication** with role-based authorization
- **Newsletter Management** with email notifications
- **Blog System** with publishing workflow
- **Contact Form** handling with email notifications
- **Project Inquiry** system with status tracking
- **Service Plans** management
- **Email Integration** with template-based system
- **Rate Limiting** and security middleware
- **Comprehensive Logging** and error handling
- **API Documentation** with Swagger UI
- **Input Validation** and sanitization
- **Pagination** and filtering support

## 📋 Prerequisites

- Node.js 18+ 
- MongoDB 4.4+
- Email service running on `localhost:3000/send-email`

## 🛠️ Installation

1. **Clone the repository**
```bash
git clone <repository-url>
cd web-agency-backend-api
```

2. **Install dependencies**
```bash
npm install
```

3. **Environment Configuration**
```bash
cp .env.example .env
```

Edit `.env` file with your configuration:
```env
# Database
MONGODB_URI=mongodb://localhost:27017/web-agency

# JWT
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRE=7d

# Admin Configuration
ADMIN_EMAIL=admin@webagency.com
ADMIN_PASSWORD=admin123

# Application
NODE_ENV=development
PORT=3000
FRONTEND_URL=http://localhost:3001
```

4. **Create Admin User**
```bash
node scripts/createAdmin.js
```

5. **Start the Server**
```bash
# Development
npm run dev

# Production
npm start
```

## 📚 API Documentation

### Base URL
```
http://localhost:3000/api
```

### Interactive Documentation
Visit `http://localhost:3000/api-docs` for Swagger UI documentation.

## 🔐 Authentication

### Admin Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "admin@webagency.com",
  "password": "admin123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "admin": {
      "_id": "...",
      "email": "admin@webagency.com",
      "name": "System Admin",
      "role": "super-admin"
    }
  }
}
```

### Protected Endpoints
Include JWT token in Authorization header:
```http
Authorization: Bearer <your-jwt-token>
```

## 📧 Newsletter API

### Subscribe to Newsletter
```http
POST /api/newsletter/subscribe
Content-Type: application/json

{
  "email": "user@example.com"
}
```

**Features:**
- Sends welcome email automatically
- Handles resubscription gracefully
- Prevents duplicate subscriptions

### Unsubscribe from Newsletter
```http
POST /api/newsletter/unsubscribe
Content-Type: application/json

{
  "email": "user@example.com"
}
```

### Get Subscribers (Admin Only)
```http
GET /api/newsletter?page=1&limit=10&status=active
Authorization: Bearer <token>
```

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `status` (optional): `active` or `inactive`

## 📝 Blog API

### Get Published Blogs
```http
GET /api/blogs?page=1&limit=10&category=tech&search=web
```

**Query Parameters:**
- `page` (optional): Page number
- `limit` (optional): Items per page
- `category` (optional): Filter by category
- `tag` (optional): Filter by tag
- `search` (optional): Search in title, excerpt, content

### Get Blog by Slug
```http
GET /api/blogs/getting-started-web-development
```

**Features:**
- Increments view count automatically
- Only returns published blogs
- Includes author information

### Create Blog (Admin Only)
```http
POST /api/blogs
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Getting Started with Modern Web Development",
  "slug": "getting-started-modern-web-development",
  "content": "<p>Full blog content...</p>",
  "excerpt": "Brief description of the blog post",
  "featuredImage": "https://example.com/image.jpg",
  "categories": ["web-development", "tutorial"],
  "tags": ["javascript", "react", "nodejs"],
  "isPublished": true
}
```

### Update Blog (Admin Only)
```http
PUT /api/blogs/{blogId}
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Updated Title",
  "isPublished": false
}
```

### Delete Blog (Admin Only)
```http
DELETE /api/blogs/{blogId}
Authorization: Bearer <token>
```

**Note:** Uses soft delete (sets `isDeleted: true`)

## 📞 Contact API

### Submit Contact Form
```http
POST /api/contact
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com",
  "phone": "+1234567890",
  "company": "Acme Corp",
  "subject": "Website Development Inquiry",
  "message": "I'm interested in your web development services..."
}
```

**Features:**
- Sends notification email to admin
- Sends confirmation email to user
- Captures IP address and user agent
- Auto-assigns priority and status

### Get Contacts (Admin Only)
```http
GET /api/contact?page=1&limit=10&status=new&priority=high
Authorization: Bearer <token>
```

**Query Parameters:**
- `page`, `limit`: Pagination
- `status`: `new`, `read`, `replied`, `closed`
- `priority`: `low`, `medium`, `high`

### Get Contact by ID (Admin Only)
```http
GET /api/contact/{contactId}
Authorization: Bearer <token>
```

**Features:**
- Automatically marks contact as "read" if status was "new"

## 🔍 Inquiry API

### Submit Project Inquiry
```http
POST /api/inquiry
Content-Type: application/json

{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "phone": "+1234567890",
  "company": "Tech Startup Inc",
  "projectType": "webapp",
  "budget": "25k-50k",
  "timeline": "3-6months",
  "description": "We need a comprehensive web application...",
  "requirements": ["User Authentication", "Payment Gateway", "Admin Dashboard"]
}
```

**Project Types:**
- `website` - Static/Dynamic websites
- `webapp` - Web applications
- `mobile` - Mobile applications
- `ecommerce` - E-commerce solutions
- `other` - Other projects

**Budget Ranges:**
- `under-5k`, `5k-10k`, `10k-25k`, `25k-50k`, `over-50k`

**Timeline Options:**
- `asap`, `1-month`, `2-3months`, `3-6months`, `flexible`

### Get Inquiries (Admin Only)
```http
GET /api/inquiry?page=1&limit=10&status=new&projectType=webapp
Authorization: Bearer <token>
```

**Query Parameters:**
- `status`: `new`, `reviewing`, `quoted`, `accepted`, `rejected`, `completed`
- `projectType`: Filter by project type
- `priority`: Filter by priority level

### Get Inquiry by ID (Admin Only)
```http
GET /api/inquiry/{inquiryId}
Authorization: Bearer <token>
```

**Features:**
- Automatically marks inquiry as "reviewing" if status was "new"
- Includes populated assignedTo and notes data

## 💼 Plans API

### Get All Plans
```http
GET /api/plans?category=website&billingCycle=monthly
```

**Query Parameters:**
- `category`: `website`, `maintenance`, `hosting`, `consulting`
- `billingCycle`: `monthly`, `yearly`, `one-time`

### Create Plan (Admin Only)
```http
POST /api/plans
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Professional Website",
  "slug": "professional-website",
  "description": "Complete professional website with custom design",
  "price": 2999,
  "currency": "USD",
  "billingCycle": "one-time",
  "category": "website",
  "features": [
    {
      "name": "Custom Design",
      "included": true,
      "description": "Fully custom website design"
    }
  ],
  "isPopular": true,
  "isActive": true,
  "order": 1
}
```

### Update Plan (Admin Only)
```http
PUT /api/plans/{planId}
Authorization: Bearer <token>
Content-Type: application/json

{
  "price": 3499,
  "isPopular": false
}
```

## 📧 Email Integration

The API integrates with your email service at `localhost:3000/send-email` using template-based emails.

### Email Templates Used

| Template ID | Purpose | Trigger |
|-------------|---------|---------|
| `NEWSLETTER_WELCOME` | Welcome new subscribers | Newsletter subscription |
| `CONTACT_NOTIFICATION` | Notify admin of new contact | Contact form submission |
| `CONTACT_CONFIRMATION` | Confirm contact submission | Contact form submission |
| `INQUIRY_NOTIFICATION` | Notify admin of new inquiry | Project inquiry submission |
| `INQUIRY_CONFIRMATION` | Confirm inquiry submission | Project inquiry submission |

### Email Payload Format
```json
{
  "to": "recipient@example.com",
  "templateId": "NEWSLETTER_WELCOME",
  "data": {
    "name": "John Doe",
    "email": "john@example.com",
    "companyName": "Web Agency"
  }
}
```

## 🔒 Security Features

- **JWT Authentication** with configurable expiration
- **Rate Limiting** (100 requests per 15 minutes per IP)
- **CORS Protection** with configurable origins
- **Helmet.js** for security headers
- **Input Sanitization** against XSS attacks
- **MongoDB Injection Protection**
- **Request Logging** for audit trails

## 📊 Response Format

### Success Response
```json
{
  "success": true,
  "message": "Operation completed successfully",
  "data": {
    // Response data
  }
}
```

### Error Response
```json
{
  "success": false,
  "message": "Descriptive error message",
  "errors": [
    {
      "field": "email",
      "message": "Please provide a valid email address",
      "value": "invalid-email"
    }
  ]
}
```

### Pagination Response
```json
{
  "success": true,
  "message": "Data retrieved successfully",
  "data": {
    "items": [...],
    "pagination": {
      "total": 100,
      "page": 1,
      "limit": 10,
      "totalPages": 10,
      "hasNextPage": true,
      "hasPrevPage": false,
      "nextPage": 2,
      "prevPage": null
    }
  }
}
```

## 🧪 Testing with Postman

1. **Import Collection**
   - Import `postman/Web-Agency-API.postman_collection.json`
   - Import `postman/Web-Agency-API.postman_environment.json`

2. **Set Environment**
   - Select "Web Agency API Environment"
   - Update `baseUrl` if different from localhost:3000

3. **Authenticate**
   - Run "Admin Login" request
   - Token will be automatically saved to environment

4. **Test Endpoints**
   - All requests are pre-configured with proper headers
   - Variables are used for dynamic values (IDs, tokens)

## 📁 Project Structure

```
├── config/
│   ├── database.js          # MongoDB connection
│   └── jwt.js               # JWT configuration
├── middleware/
│   ├── auth.js              # Authentication middleware
│   ├── errorHandler.js      # Global error handling
│   ├── requestLogger.js     # Request logging
│   └── validation.js        # Input validation
├── models/
│   ├── Admin.js             # Admin user model
│   ├── Blog.js              # Blog post model
│   ├── Contact.js           # Contact form model
│   ├── Inquiry.js           # Project inquiry model
│   ├── Newsletter.js        # Newsletter subscription model
│   └── Plan.js              # Service plan model
├── routes/
│   ├── auth.js              # Authentication routes
│   ├── blog.js              # Blog management routes
│   ├── contact.js           # Contact form routes
│   ├── inquiry.js           # Project inquiry routes
│   ├── newsletter.js        # Newsletter routes
│   └── plans.js             # Service plans routes
├── scripts/
│   └── createAdmin.js       # Admin user creation script
├── utils/
│   ├── email.js             # Email service integration
│   ├── logger.js            # Winston logger configuration
│   └── pagination.js       # Pagination utilities
├── validation/
│   ├── authValidation.js    # Auth input validation
│   ├── blogValidation.js    # Blog input validation
│   ├── contactValidation.js # Contact input validation
│   ├── inquiryValidation.js # Inquiry input validation
│   ├── newsletterValidation.js # Newsletter validation
│   └── planValidation.js    # Plan input validation
├── postman/
│   ├── Web-Agency-API.postman_collection.json
│   └── Web-Agency-API.postman_environment.json
├── logs/                    # Application logs
├── .env.example             # Environment variables template
├── package.json
├── server.js                # Main application file
└── README.md
```

## 🚀 Deployment

### Environment Variables for Production
```env
NODE_ENV=production
PORT=3000
MONGODB_URI=mongodb://your-production-db
JWT_SECRET=your-super-secure-production-secret
FRONTEND_URL=https://your-frontend-domain.com
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=secure-admin-password
```

### Production Considerations

1. **Database**
   - Use MongoDB Atlas or dedicated MongoDB server
   - Enable authentication and SSL
   - Set up regular backups

2. **Security**
   - Use strong JWT secret (32+ characters)
   - Enable HTTPS
   - Configure proper CORS origins
   - Set up firewall rules

3. **Monitoring**
   - Monitor application logs
   - Set up health check endpoints
   - Configure error alerting

4. **Performance**
   - Enable MongoDB indexing
   - Configure connection pooling
   - Set up caching if needed

## 🐛 Troubleshooting

### Common Issues

1. **MongoDB Connection Failed**
   ```
   Error: connect ECONNREFUSED 127.0.0.1:27017
   ```
   - Ensure MongoDB is running
   - Check MONGODB_URI in .env file

2. **JWT Token Invalid**
   ```
   {"success": false, "message": "Invalid token"}
   ```
   - Check if token is properly included in Authorization header
   - Verify JWT_SECRET matches between login and verification

3. **Email Service Unavailable**
   ```
   Email sending failed: connect ECONNREFUSED
   ```
   - Ensure email service is running on localhost:3000/send-email
   - Check email service logs

4. **Validation Errors**
   ```
   {"success": false, "message": "Validation failed"}
   ```
   - Check request body format
   - Ensure required fields are included
   - Verify data types match validation rules

### Debug Mode
Set `NODE_ENV=development` for detailed error messages and console logging.

## 📄 License

This project is licensed under the MIT License.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## 📞 Support

For support and questions:
- Create an issue in the repository
- Check the API documentation at `/api-docs`
- Review the Postman collection for examples