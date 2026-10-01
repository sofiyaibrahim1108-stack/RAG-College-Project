import os
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
import zipfile

os.makedirs("test_data", exist_ok=True)

# 1. Generate an Architecture Diagram Image
img_path = "test_data/mongodb_architecture.png"
img = Image.new("RGB", (600, 350), color=(240, 244, 248))
draw = ImageDraw.Draw(img)
# Draw mock architecture boxes
draw.rectangle([50, 50, 250, 150], fill=(22, 163, 74), outline=(21, 128, 61), width=2)
draw.text((70, 90), "MongoDB Primary Replica", fill=(255, 255, 255))
draw.rectangle([350, 50, 550, 150], fill=(37, 99, 235), outline=(29, 78, 216), width=2)
draw.text((370, 90), "Secondary Replica", fill=(255, 255, 255))
draw.rectangle([200, 200, 400, 300], fill=(234, 88, 12), outline=(194, 65, 12), width=2)
draw.text((220, 240), "WiredTiger Storage Engine", fill=(255, 255, 255))
img.save(img_path)
print("Generated diagram:", img_path)

# Also generate a React component lifecycle diagram
react_img_path = "test_data/react_components.png"
react_img = Image.new("RGB", (600, 350), color=(245, 247, 250))
r_draw = ImageDraw.Draw(react_img)
r_draw.rectangle([50, 50, 250, 150], fill=(99, 102, 241), outline=(79, 70, 229), width=2)
r_draw.text((70, 90), "React Component (JSX)", fill=(255, 255, 255))
r_draw.rectangle([350, 50, 550, 150], fill=(13, 148, 136), outline=(15, 118, 110), width=2)
r_draw.text((370, 90), "Virtual DOM Reconciler", fill=(255, 255, 255))
r_draw.rectangle([200, 200, 400, 300], fill=(217, 70, 239), outline=(162, 28, 175), width=2)
r_draw.text((230, 240), "Real DOM Renderer", fill=(255, 255, 255))
react_img.save(react_img_path)
print("Generated diagram:", react_img_path)

# 2. Generate PDF with text & embedded images
pdf_path = "test_data/mongodb_guide.pdf"
c = canvas.Canvas(pdf_path, pagesize=letter)

# Page 1: MongoDB Core & Indexing
c.setFont("Helvetica-Bold", 18)
c.drawString(50, 750, "MongoDB Enterprise Architecture & Indexing Guide")
c.setFont("Helvetica", 12)
text_lines_p1 = [
    "MongoDB is a high-performance, document-oriented NoSQL database system.",
    "It stores records as flexible BSON (Binary JSON) documents with dynamic schemas.",
    "",
    "Indexing in MongoDB:",
    "Indexes support the efficient execution of queries in MongoDB. Without indexes,",
    "MongoDB must perform a collection scan (COLLSCAN), scanning every document in a collection",
    "to select those documents that match the query statement.",
    "Indexes in MongoDB use a B-tree data structure to hold a small portion of the collection's data set",
    "in an easy-to-traverse form. The index stores the value of a specific field or set of fields,",
    "ordered by the value of the field.",
    "",
    "Types of Indexes in MongoDB:",
    "- Single Field Indexes: Indexes on a single field of a document.",
    "- Compound Indexes: User-defined indexes on multiple fields to accelerate complex queries.",
    "- Multikey Indexes: Indexes on array fields to index array elements.",
    "- Text Indexes: Supports search queries on string content with stemming and stop words.",
    "- Geospatial Indexes: 2dsphere indexes for querying coordinate data."
]
y = 710
for line in text_lines_p1:
    c.drawString(50, y, line)
    y -= 18

c.drawImage(img_path, 50, y - 250, width=500, height=230)
c.showPage()

# Page 2: Storage Engine & Replica Sets
c.setFont("Helvetica-Bold", 16)
c.drawString(50, 750, "Page 2: WiredTiger Storage Engine and High Availability")
c.setFont("Helvetica", 12)
text_lines_p2 = [
    "WiredTiger is the default storage engine starting in MongoDB 3.2.",
    "It provides document-level concurrency control, checkpointing, and compression (Snappy and zlib).",
    "Replica sets provide redundancy and high availability. A replica set consists of one primary node",
    "which receives all write operations, and multiple secondary nodes that replicate the primary's oplog.",
    "",
    "Query Optimization:",
    "Use explain('executionStats') to examine whether queries utilize indexes (IXSCAN) or resort",
    "to full collection scans. Covered queries occur when all queried fields are part of the index,",
    "allowing MongoDB to return results directly from the index without scanning documents in memory."
]
y = 710
for line in text_lines_p2:
    c.drawString(50, y, line)
    y -= 20
c.showPage()
c.save()
print("Generated PDF:", pdf_path)

# 3. Generate DOCX with text and embedded image
docx_path = "test_data/react_architecture.docx"
# A docx file is a zip file with [Content_Types].xml, _rels/.rels, word/document.xml, and word/media/
with zipfile.ZipFile(docx_path, "w") as docx:
    # [Content_Types].xml
    docx.writestr("[Content_Types].xml", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>""")
    # _rels/.rels
    docx.writestr("_rels/.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>""")
    # word/_rels/document.xml.rels
    docx.writestr("word/_rels/document.xml.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/react_components.png"/>
</Relationships>""")
    # word/document.xml
    docx.writestr("word/document.xml", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>React Architecture and Component Guide</w:t></w:r></w:p>
    <w:p><w:r><w:t>React is a declarative, component-based JavaScript library for building user interfaces created by Meta.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Components in React: Components let you split the UI into independent, reusable pieces, and think about each piece in isolation. React components accept inputs called props and return React elements describing what should appear on the screen.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Hooks in React: Hooks such as useState and useEffect allow function components to manage local state and handle side effects like data fetching and DOM manipulation.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Virtual DOM: React maintains an in-memory Virtual DOM representation. When state changes, React computes the diff between the previous and new virtual DOM tree (Reconciliation) and batch-updates the real browser DOM with minimal reflow.</w:t></w:r></w:p>
  </w:body>
</w:document>""")
    # Add image to word/media/
    with open(react_img_path, "rb") as f:
        docx.writestr("word/media/react_components.png", f.read())
print("Generated DOCX:", docx_path)

# 4. Generate TXT document for SQL vs NoSQL
txt_path = "test_data/sql_vs_nosql.txt"
with open(txt_path, "w", encoding="utf-8") as f:
    f.write("""Database Systems Comparison: SQL vs NoSQL

SQL (Relational Databases):
Relational databases such as PostgreSQL, MySQL, and Oracle use structured query language (SQL) and rigid table schemas.
Key Characteristics of SQL:
- Schema: Fixed schema with predefined columns and strict data types.
- ACID Compliance: Guarantees Atomicity, Consistency, Isolation, and Durability for transactions.
- Scaling: Primarily vertical scaling (scaling up by adding more CPU, RAM, and SSD power).
- Relationships: Supports complex JOIN operations across multiple tables.

NoSQL (Non-Relational Databases):
NoSQL databases such as MongoDB, Cassandra, and Redis provide flexible data models designed for horizontal scalability.
Key Characteristics of NoSQL:
- Schema: Dynamic and flexible schemas (documents, key-value, wide-column, graphs).
- CAP Theorem / BASE: Focuses on Basically Available, Soft state, and Eventual consistency.
- Scaling: Horizontal scaling (scale-out across distributed commodity clusters via sharding).
- Performance: High-throughput read/write operations without overhead of multi-table joins.
""")
print("Generated TXT:", txt_path)
