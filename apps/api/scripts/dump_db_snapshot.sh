#!/bin/bash

if [ $# -eq 0 ]; then
  echo "Missing destination path"
elif [ $# -eq 1 ]; then
  echo "Missing connection string"
else
  echo "Dumping snapshot"
  pg_dump -F c -bv -f "$(echo $1)" -d "$(echo $2)"
fi
