import XLSX from "xlsx";
import fs from "fs";

// Create a synthetic employee dataset to test dataset generalization
const employeeData = [
  { Employee: "Alice Smith", Department: "Engineering", Salary: 95000, Experience: 6, Rating: 4.8 },
  { Employee: "Bob Jones", Department: "Engineering", Salary: 82000, Experience: 4, Rating: 4.2 },
  { Employee: "Charlie Brown", Department: "HR", Salary: 65000, Experience: 5, Rating: 4.5 },
  { Employee: "Diana Prince", Department: "HR", Salary: 72000, Experience: 7, Rating: 4.9 },
  { Employee: "Evan Wright", Department: "Marketing", Salary: 78000, Experience: 3, Rating: 3.9 },
  { Employee: "Fiona Gallagher", Department: "Marketing", Salary: 88000, Experience: 8, Rating: 4.6 }
];

const empWb = XLSX.utils.book_new();
const empWs = XLSX.utils.json_to_sheet(employeeData);
XLSX.utils.book_append_sheet(empWb, empWs, "Employees");
const empPath = "d:/Development/RAG-College/backend/scratch/employees.xlsx";
XLSX.writeFile(empWb, empPath);

console.log("Created synthetic employees.xlsx for cross-dataset generalization tests.");
